#!/usr/bin/env node
// Generate overlay/api-router/routes.json from the upstream terraform API
// module (API Gateway REST resources/methods/integrations). Re-run after every
// upstream update so new routes are picked up automatically.
//
// Join logic mirrors terraform:
//   aws_api_gateway_resource   → path tree (parent_id + path_part)
//   aws_api_gateway_method     → HTTP method + authorization per resource
//   aws_api_gateway_integration→ target lambda (uri var name) per resource+method
// Lambda name: var.<x>_lambda_invoke_arn → lambda/<x with _ → ->;
//              module.<x>_lambda.lambda_function_invoke_arn → lambda/<x>.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(root, 'upstream/collab/terraform/modules/api');
const outFile = path.join(root, 'overlay/api-router/routes.json');

const source = ['main.tf', 'routes.tf', 'agents.tf']
  .map((f) => readFileSync(path.join(apiDir, f), 'utf8'))
  .join('\n');

// --- block scanner ----------------------------------------------------------
const blocks = { resource: {}, method: {}, integration: {} };
const kindMap = {
  aws_api_gateway_resource: 'resource',
  aws_api_gateway_method: 'method',
  aws_api_gateway_integration: 'integration',
};
const blockRe = /^resource "(\w+)" "(\w+)" \{$/;
const lines = source.split('\n');
for (let i = 0; i < lines.length; i += 1) {
  const m = lines[i].match(blockRe);
  if (!m || !kindMap[m[1]]) continue;
  const body = [];
  let depth = 1;
  for (i += 1; i < lines.length && depth > 0; i += 1) {
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    if (depth > 0) body.push(lines[i]);
  }
  i -= 1;
  blocks[kindMap[m[1]]][m[2]] = body.join('\n');
}

const attr = (body, name) => body.match(new RegExp(`^\\s*${name}\\s*= (.*)$`, 'm'))?.[1]?.trim();

// --- locals maps used by for_each -------------------------------------------
// Shape:  <mapName> = {\n    <key> = { attr = value, ... }\n    ... }
// Values stay as raw terraform expressions; each.value.<attr> substitution
// later resolves them exactly like the non-for_each attrs.
const localMaps = {};
for (let i = 0; i < lines.length; i += 1) {
  const m = lines[i].match(/^\s{2}(\w+)\s*= \{$/);
  if (!m) continue;
  const entries = {};
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s{2}\}/.test(line)) break;
    const entry = line.match(/^\s+([\w-]+)\s*= \{(.*)$/);
    if (!entry) continue;
    const attrs = {};
    let rest = entry[2];
    // single-line `k = { a = b, c = d }` or multi-line entries
    if (!rest.includes('}')) {
      const inner = [];
      for (i += 1; i < lines.length && !/^\s+\}/.test(lines[i]); i += 1) inner.push(lines[i]);
      rest = inner.join(',');
    }
    for (const pair of rest.replace(/\}\s*$/, '').split(',')) {
      const kv = pair.match(/([\w.]+)\s*= (.+)/);
      if (kv) attrs[kv[1].trim()] = kv[2].trim();
    }
    entries[entry[1]] = attrs;
  }
  if (Object.keys(entries).length) localMaps[m[1]] = entries;
}

// Expand for_each method/integration blocks into synthetic named blocks
// (`name[key]`) with each.value.<attr> / indexed references substituted.
for (const kind of ['method', 'integration']) {
  for (const [name, body] of Object.entries({ ...blocks[kind] })) {
    const fe = attr(body, 'for_each')?.match(/^local\.(\w+)$/);
    if (!fe) continue;
    const map = localMaps[fe[1]];
    if (!map) throw new Error(`gen-routes: for_each references unknown local.${fe[1]} in ${name}`);
    delete blocks[kind][name];
    for (const [key, attrs] of Object.entries(map)) {
      let expanded = body
        .replaceAll(/each\.value\.(\w+)/g, (_, a) => attrs[a] ?? `MISSING(${a})`)
        .replaceAll('each.key', `"${key}"`)
        .replaceAll(/aws_api_gateway_method\.(\w+)\[[^\]]+\]/g, `aws_api_gateway_method.$1[${key}]`);
      blocks[kind][`${name}[${key}]`] = expanded;
    }
  }
}

// --- resource path tree -----------------------------------------------------
const resources = {};
for (const [name, body] of Object.entries(blocks.resource)) {
  resources[name] = {
    parent: attr(body, 'parent_id') ?? '',
    pathPart: attr(body, 'path_part')?.replace(/^"|"$/g, '') ?? '',
  };
}
const resourcePath = (name, seen = new Set()) => {
  if (seen.has(name)) throw new Error(`resource cycle at ${name}`);
  seen.add(name);
  const r = resources[name];
  if (!r) throw new Error(`unknown resource ${name}`);
  const parentMatch = r.parent.match(/aws_api_gateway_resource\.(\w+)\.id/);
  const parentPath = parentMatch ? resourcePath(parentMatch[1], seen) : '';
  return `${parentPath}/${r.pathPart}`;
};

// --- methods ----------------------------------------------------------------
const methods = {};
for (const [name, body] of Object.entries(blocks.method)) {
  const resourceRef = attr(body, 'resource_id')?.match(/aws_api_gateway_resource\.(\w+)\.id/)?.[1];
  methods[name] = {
    resource: resourceRef,
    httpMethod: attr(body, 'http_method')?.replace(/^"|"$/g, ''),
    authorization: attr(body, 'authorization')?.replace(/^"|"$/g, '') ?? 'NONE',
  };
}

// --- integrations → routes --------------------------------------------------
const routes = [];
for (const [name, body] of Object.entries(blocks.integration)) {
  const type = attr(body, 'type')?.replace(/^"|"$/g, '');
  const resourceRef = attr(body, 'resource_id')?.match(/aws_api_gateway_resource\.(\w+)\.id/)?.[1];
  if (!resourceRef) continue;

  let httpMethod = attr(body, 'http_method') ?? '';
  const methodRef = httpMethod.match(/aws_api_gateway_method\.(\w+(?:\[[\w-]+\])?)\.http_method/)?.[1];
  const method = methodRef ? methods[methodRef] : undefined;
  httpMethod = method?.httpMethod ?? httpMethod.replace(/^"|"$/g, '');

  let uri = attr(body, 'uri') ?? '';
  // resolve one level of `local.x = var.y…` indirection (e.g. trackers)
  const localMatch = uri.match(/^local\.(\w+)$/);
  if (localMatch) {
    uri = source.match(new RegExp(`^\\s*${localMatch[1]}\\s*= (.*)$`, 'm'))?.[1]?.trim() ?? uri;
  }
  let lambda = null;
  const varMatch = uri.match(/var\.(\w+)_lambda_invoke_arn/);
  const moduleMatch = uri.match(/module\.(\w+)_lambda\.lambda_function_invoke_arn/);
  if (varMatch) lambda = varMatch[1].replaceAll('_', '-');
  else if (moduleMatch) lambda = moduleMatch[1].replaceAll('_', '-');

  if (type !== 'AWS_PROXY' && type !== 'MOCK') {
    console.warn(`gen-routes: skipping integration ${name} with type ${type}`);
    continue;
  }
  if (type === 'AWS_PROXY' && !lambda) {
    throw new Error(`gen-routes: integration ${name} is AWS_PROXY but has unrecognized uri: ${uri}`);
  }

  routes.push({
    method: httpMethod,
    resource: resourcePath(resourceRef),
    lambda: type === 'MOCK' ? null : lambda,
    type: type === 'MOCK' ? 'mock' : 'lambda',
    auth: (method?.authorization ?? 'NONE') !== 'NONE',
  });
}

routes.sort((a, b) => a.resource.localeCompare(b.resource) || a.method.localeCompare(b.method));

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(routes, null, 2)}\n`);

const lambdas = [...new Set(routes.map((r) => r.lambda).filter(Boolean))].sort();
console.log(`gen-routes: ${routes.length} routes → ${path.relative(root, outFile)}`);
console.log(`  lambdas: ${lambdas.join(', ')}`);
