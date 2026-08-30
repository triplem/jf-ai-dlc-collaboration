// Bedrock AgentCore control-plane replacement.
//
// The backend invokes agent sessions with @aws-sdk/client-bedrock-agentcore's
// InvokeAgentRuntime; pointing AWS_ENDPOINT_URL_BEDROCK_AGENTCORE at this
// server keeps that code unchanged. Wire protocol served here:
//   POST /runtimes/{agentRuntimeArn}/invocations[?qualifier=…]
//   header X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <sessionId>
//   body = JSON payload → response = agentcore JSON response
//
// The upstream agentcore image (lambda/agentcore/Dockerfile) listens on 8080
// POST /invocations; the SAME session id must reach the SAME container so the
// session workspace persists (upstream microVM semantic).
//
// Backends (SESSION_BACKEND):
//   http    one always-on runtime container, all sessions share it
//           (AGENT_RUNTIME_URL, compose default — fine for local testing)
//   docker  container per session via the docker CLI on the mounted socket:
//           name ac-<hash(sessionId)>, joined to DOCKER_NETWORK, reaped after
//           SESSION_IDLE_SECONDS idle (AGENT_IMAGE, AGENT_ENV: comma-separated
//           env var names forwarded into the container)
//
// Env: PORT (default 3003)

import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const backend = process.env.SESSION_BACKEND || 'http';
const port = Number(process.env.PORT || 3003);

const sessions = new Map(); // sessionId → { url, lastUsed }

const containerName = (sessionId) => `ac-${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`;

const ensureSession = async (sessionId) => {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.url;
  }
  let url;
  if (backend === 'http') {
    url = process.env.AGENT_RUNTIME_URL || 'http://agentcore:8080';
  } else if (backend === 'docker') {
    const name = containerName(sessionId);
    const image = process.env.AGENT_IMAGE;
    if (!image) throw new Error('AGENT_IMAGE is required for SESSION_BACKEND=docker');
    const network = process.env.DOCKER_NETWORK || 'bridge';
    const envArgs = (process.env.AGENT_ENV || '')
      .split(',')
      .filter(Boolean)
      .flatMap((k) => ['-e', `${k}=${process.env[k] ?? ''}`]);
    const running = await exec('docker', ['ps', '-q', '--filter', `name=^${name}$`]);
    if (!running.stdout.trim()) {
      await exec('docker', ['rm', '-f', name]).catch(() => {});
      await exec('docker', ['run', '-d', '--name', name, '--network', network, ...envArgs, image]);
    }
    url = `http://${name}:8080`;
  } else {
    throw new Error(`unknown SESSION_BACKEND: ${backend}`);
  }
  sessions.set(sessionId, { url, lastUsed: Date.now() });
  return url;
};

// Idle reaper for docker backend
if (backend === 'docker') {
  const idleMs = Number(process.env.SESSION_IDLE_SECONDS || 1800) * 1000;
  setInterval(async () => {
    const now = Date.now();
    for (const [sessionId, s] of sessions) {
      if (now - s.lastUsed > idleMs) {
        sessions.delete(sessionId);
        await exec('docker', ['rm', '-f', containerName(sessionId)]).catch(() => {});
      }
    }
  }, 60_000).unref();
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    const m = req.url.match(/^\/runtimes\/[^/]+\/invocations/);
    if (!m || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
      return;
    }
    const sessionId =
      req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] || 'default-session';
    const body = await readBody(req);
    const url = await ensureSession(sessionId);

    // Session workspaces make invocations long-running (init-ws clones repos,
    // run-stage runs a full agent stage) — no client timeout here; the SDK
    // caller owns its own timeout policy.
    const upstreamRes = await fetch(`${url}/invocations`, {
      method: 'POST',
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'x-amzn-bedrock-agentcore-runtime-session-id': sessionId,
      },
      body,
    });
    const responseBody = Buffer.from(await upstreamRes.arrayBuffer());
    res.writeHead(upstreamRes.status, {
      'content-type': upstreamRes.headers.get('content-type') || 'application/json',
    });
    res.end(responseBody);
  } catch (err) {
    console.error('invoke failed:', err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: String(err?.message || err) }));
  }
});

server.listen(port, () => console.log(`session-runner (${backend}) listening on :${port}`));
