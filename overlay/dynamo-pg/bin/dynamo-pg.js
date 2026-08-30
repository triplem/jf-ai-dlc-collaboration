#!/usr/bin/env node
'use strict';

const { startServer } = require('../src/server');

const connectionString = process.env.DYNAMO_PG_URL;
const port = Number(process.env.PORT || 8000);

startServer({ connectionString, port })
  .then(({ port: boundPort }) => {
    console.log(`dynamo-pg listening on :${boundPort}`);
  })
  .catch((err) => {
    console.error('dynamo-pg failed to start:', err.message);
    process.exit(1);
  });
