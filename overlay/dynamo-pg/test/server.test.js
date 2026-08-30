'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GenericContainer, Wait } = require('testcontainers');
const { DynamoDBClient, CreateTableCommand } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
  TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');

const { startServer } = require('../src/server');

let pgContainer;
let server;
let ddb;
let connectionString;

const makeClient = (port) =>
  DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    }),
  );

test.before(async () => {
  pgContainer = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'ddb' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  connectionString = `postgres://postgres:test@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/ddb`;
  server = await startServer({ connectionString, port: 0, host: '127.0.0.1' });
  ddb = makeClient(server.port);

  await ddb.send(
    new CreateTableCommand({
      TableName: 'things',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'owner', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'by-owner',
          KeySchema: [{ AttributeName: 'owner', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
}, { timeout: 120_000 });

test.after(async () => {
  await server?.close();
  await pgContainer?.stop();
});

test('put / get / update / delete round trip', async () => {
  await ddb.send(
    new PutCommand({ TableName: 'things', Item: { pk: 'a', sk: '1', owner: 'u1', n: 1, nested: { x: [1, 2] } } }),
  );
  let { Item } = await ddb.send(new GetCommand({ TableName: 'things', Key: { pk: 'a', sk: '1' } }));
  assert.deepEqual(Item, { pk: 'a', sk: '1', owner: 'u1', n: 1, nested: { x: [1, 2] } });

  await ddb.send(
    new UpdateCommand({
      TableName: 'things',
      Key: { pk: 'a', sk: '1' },
      UpdateExpression: 'SET n = n + :inc, #o = :o REMOVE nested',
      ExpressionAttributeNames: { '#o': 'owner' },
      ExpressionAttributeValues: { ':inc': 5, ':o': 'u2' },
    }),
  );
  ({ Item } = await ddb.send(new GetCommand({ TableName: 'things', Key: { pk: 'a', sk: '1' } })));
  assert.deepEqual(Item, { pk: 'a', sk: '1', owner: 'u2', n: 6 });

  await ddb.send(new DeleteCommand({ TableName: 'things', Key: { pk: 'a', sk: '1' } }));
  ({ Item } = await ddb.send(new GetCommand({ TableName: 'things', Key: { pk: 'a', sk: '1' } })));
  assert.equal(Item, undefined);
});

test('query on key condition and on a GSI', async () => {
  for (const sk of ['1', '2', '3']) {
    await ddb.send(new PutCommand({ TableName: 'things', Item: { pk: 'q', sk, owner: 'alice' } }));
  }
  const byKey = await ddb.send(
    new QueryCommand({
      TableName: 'things',
      KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b',
      ExpressionAttributeValues: { ':p': 'q', ':a': '1', ':b': '2' },
    }),
  );
  assert.deepEqual(byKey.Items.map((i) => i.sk), ['1', '2']);

  const byOwner = await ddb.send(
    new QueryCommand({
      TableName: 'things',
      IndexName: 'by-owner',
      KeyConditionExpression: '#o = :o',
      ExpressionAttributeNames: { '#o': 'owner' },
      ExpressionAttributeValues: { ':o': 'alice' },
    }),
  );
  assert.equal(byOwner.Items.length, 3);
});

test('conditional put fails on existing item', async () => {
  await ddb.send(new PutCommand({ TableName: 'things', Item: { pk: 'c', sk: '1' } }));
  await assert.rejects(
    ddb.send(
      new PutCommand({
        TableName: 'things',
        Item: { pk: 'c', sk: '1' },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    ),
    /ConditionalCheckFailed/,
  );
});

test('batch write puts and deletes', async () => {
  await ddb.send(
    new BatchWriteCommand({
      RequestItems: {
        things: [
          { PutRequest: { Item: { pk: 'b', sk: '1' } } },
          { PutRequest: { Item: { pk: 'b', sk: '2' } } },
        ],
      },
    }),
  );
  await ddb.send(
    new BatchWriteCommand({
      RequestItems: { things: [{ DeleteRequest: { Key: { pk: 'b', sk: '1' } } }] },
    }),
  );
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: 'things',
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': 'b' },
    }),
  );
  assert.deepEqual(Items.map((i) => i.sk), ['2']);
});

test('transact write commits all items', async () => {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: 'things', Item: { pk: 't', sk: '1' }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: 'things', Item: { pk: 't', sk: '2' } } },
      ],
    }),
  );
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: 'things',
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': 't' },
    }),
  );
  assert.equal(Items.length, 2);
});

test('transact write cancels and rolls back on condition failure', async () => {
  await ddb.send(new PutCommand({ TableName: 'things', Item: { pk: 'tx', sk: 'existing', v: 'old' } }));
  await assert.rejects(
    ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: 'things', Item: { pk: 'tx', sk: 'new' } } },
          { Put: { TableName: 'things', Item: { pk: 'tx', sk: 'existing', v: 'clobbered' }, ConditionExpression: 'attribute_not_exists(pk)' } },
        ],
      }),
    ),
    /TransactionCanceled/,
  );
  // first item rolled back, existing item untouched
  const first = await ddb.send(new GetCommand({ TableName: 'things', Key: { pk: 'tx', sk: 'new' } }));
  assert.equal(first.Item, undefined);
  const existing = await ddb.send(new GetCommand({ TableName: 'things', Key: { pk: 'tx', sk: 'existing' } }));
  assert.equal(existing.Item.v, 'old');
});

test('data survives a server restart (postgres persistence)', async () => {
  await ddb.send(new PutCommand({ TableName: 'things', Item: { pk: 'persist', sk: '1', v: 42 } }));
  await server.close();
  server = await startServer({ connectionString, port: 0, host: '127.0.0.1' });
  ddb = makeClient(server.port);
  const { Item } = await ddb.send(new GetCommand({ TableName: 'things', Key: { pk: 'persist', sk: '1' } }));
  assert.equal(Item.v, 42);
});
