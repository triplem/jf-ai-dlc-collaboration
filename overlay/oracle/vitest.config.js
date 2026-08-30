// Upstream vitest config with one substitution: DynamoDB Local → dynamo-pg
// (see ./dynamodb-setup.js). Run from upstream/collab:
//   npx vitest run -c ../../overlay/oracle/vitest.config.js
import { fileURLToPath } from 'node:url';
import upstream from '../../upstream/collab/vitest.config.js';

const config = upstream;
config.test.globalSetup = config.test.globalSetup.map((file) =>
  file.endsWith('dynamodb-setup.js')
    ? fileURLToPath(new URL('./dynamodb-setup.js', import.meta.url))
    : file,
);

export default config;
