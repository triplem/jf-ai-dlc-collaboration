// One-shot stack bootstrap: create all DynamoDB tables (tables.json, generated
// by scripts/gen-tables.mjs) against dynamo-pg, and the S3 buckets against the
// SeaweedFS S3 endpoint. Idempotent — safe to run on every stack start.
//
// Env: DYNAMO_ENDPOINT (default http://dynamo-pg:8000)
//      S3_ENDPOINT     (default http://seaweedfs:8333)
//      PROJECT_NAME    (default aidlc)   ENVIRONMENT (default local)
//      BUCKETS         comma-separated (default artifacts)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tables = JSON.parse(readFileSync(path.join(here, 'tables.json'), 'utf8'));

const dynamoEndpoint = process.env.DYNAMO_ENDPOINT || 'http://dynamo-pg:8000';
const s3Endpoint = process.env.S3_ENDPOINT || 'http://seaweedfs:8333';
const project = process.env.PROJECT_NAME || 'aidlc';
const environment = process.env.ENVIRONMENT || 'local';

const dynamoCall = async (op, payload) => {
  const res = await fetch(dynamoEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': `DynamoDB_20120810.${op}`,
      'x-amz-date': '20120810T000000Z',
      authorization:
        'AWS4-HMAC-SHA256 Credential=bootstrap/20120810/local/dynamodb/aws4_request, SignedHeaders=host, Signature=0',
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
};

for (const table of tables) {
  const spec = {
    ...table,
    TableName: table.TableName.replaceAll('{project}', project).replaceAll('{environment}', environment),
  };
  const result = await dynamoCall('CreateTable', spec);
  if (result.status === 200) console.log(`created table ${spec.TableName}`);
  else if (result.body.__type?.includes('ResourceInUseException')) console.log(`table ${spec.TableName} exists`);
  else throw new Error(`CreateTable ${spec.TableName} failed: ${JSON.stringify(result.body)}`);
}

for (const bucket of (process.env.BUCKETS || 'artifacts').split(',').filter(Boolean)) {
  const res = await fetch(`${s3Endpoint}/${bucket}`, { method: 'PUT' });
  if (res.ok || res.status === 409) console.log(`bucket ${bucket} ready`);
  else console.warn(`bucket ${bucket} creation returned ${res.status}`);
}

console.log('bootstrap complete');
