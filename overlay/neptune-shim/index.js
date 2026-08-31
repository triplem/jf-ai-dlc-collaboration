// OSS substitute for the AWS-internal `neptune-lambda-client` package.
//
// The upstream lambdas (discussions, questions, timeline-events) do
//   const { query, close } = create(endpoint, port, { useIam, protocol, partition })
//   const role = await query((g) => g.V()...next())
// against AWS Neptune (wss:// + SigV4). This OSS port runs plain JanusGraph /
// Gremlin Server (ws://, no IAM), which agentcore's graph path already talks to
// directly (`agentcore/mcp/graph-writer.js`). This shim gives those three
// lambdas the same `{ query, close }` interface over a plain Gremlin connection.
//
// Not committed into upstream/ — it's dropped into node_modules at image build
// time (deploy/compose/Dockerfile.services), keeping the subtree pristine.
import gremlin from 'gremlin';

const { DriverRemoteConnection } = gremlin.driver;
const { traversal } = gremlin.process.AnonymousTraversalSource;

/**
 * @param {string} endpoint   Gremlin host (NEPTUNE_ENDPOINT).
 * @param {string} [port]     Gremlin port (default 8182).
 * @param {object} [opts]     { useIam, protocol, partition }.
 *   - protocol:  'ws' (OSS) or 'wss'. IAM/SigV4 (`useIam`) is NOT implemented —
 *     there is no Neptune here; the OSS stack uses plain ws:// Gremlin Server.
 *   - partition: Neptune multi-tenant partitioning — unused off-AWS; ignored
 *     (GREMLIN_PARTITION is unset in this deployment).
 * @returns {{ query: (fn: (g:any)=>Promise<any>)=>Promise<any>, close: ()=>Promise<void> }}
 */
export function create(endpoint, port = '8182', opts = {}) {
  const protocol = opts.protocol ?? 'ws';
  const url = `${protocol}://${endpoint}:${port}/gremlin`;

  // One warm connection + traversal source, reused across calls (matches the
  // upstream clients.js contract: "constructed once and shared").
  let connection = null;
  let g = null;
  const source = () => {
    if (!g) {
      connection = new DriverRemoteConnection(url, {});
      g = traversal().withRemote(connection);
    }
    return g;
  };

  return {
    // `fn` receives the live traversal source and returns a traversal promise
    // (e.g. `g.V(...).next()`); we just hand it the warm `g`.
    query: (fn) => fn(source()),
    close: async () => {
      try {
        await connection?.close?.();
      } catch {
        /* already closed / unreachable — the fd is gone either way */
      }
      connection = null;
      g = null;
    },
  };
}

export default { create };
