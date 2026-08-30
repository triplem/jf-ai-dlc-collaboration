#!/usr/bin/env node
// Generate overlay/bootstrap/tables.json from every aws_dynamodb_table in the
// upstream terraform (names keep the ${var.project_name}/-${var.environment}
// templates as {project}/{environment} placeholders; the bootstrap substitutes
// them). Re-run after every upstream update.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tfRoot = path.join(root, 'upstream/collab/terraform');
const outFile = path.join(root, 'overlay/bootstrap/tables.json');

const tfFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.tf')) tfFiles.push(p);
  }
};
walk(tfRoot);

const tables = [];
for (const file of tfFiles) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^resource "aws_dynamodb_table" "\w+" \{$/.test(lines[i])) continue;
    const body = [];
    let depth = 1;
    for (i += 1; i < lines.length && depth > 0; i += 1) {
      depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
      if (depth > 0) body.push(lines[i]);
    }
    i -= 1;
    const text = body.join('\n');
    const attr = (name, from = text) => from.match(new RegExp(`^\\s*${name}\\s*= "?([^"\\n]+)"?$`, 'm'))?.[1]?.trim();

    const name = attr('name')
      ?.replaceAll('${var.project_name}', '{project}')
      .replaceAll('${var.environment}', '{environment}');
    const attributes = [...text.matchAll(/attribute \{\s*\n\s*name = "(\w+)"\s*\n\s*type = "(\w+)"/g)].map(
      (m) => ({ AttributeName: m[1], AttributeType: m[2] }),
    );
    // GSI blocks may nest key_schema sub-blocks — extract brace-balanced.
    const gsiBodies = [];
    const bodyLines = text.split('\n');
    for (let j = 0; j < bodyLines.length; j += 1) {
      if (!/^\s*global_secondary_index \{/.test(bodyLines[j])) continue;
      let d = 1;
      const inner = [];
      for (j += 1; j < bodyLines.length && d > 0; j += 1) {
        d += (bodyLines[j].match(/\{/g) || []).length - (bodyLines[j].match(/\}/g) || []).length;
        if (d > 0) inner.push(bodyLines[j]);
      }
      j -= 1;
      gsiBodies.push(inner.join('\n'));
    }
    const gsis = gsiBodies.map((g) => {
      const gAttr = (n) => g.match(new RegExp(`^\\s*${n}\\s*= "?([^"\\n]+)"?$`, 'm'))?.[1]?.trim();
      // flat syntax (hash_key/range_key) or nested key_schema blocks
      let keySchema;
      const nested = [...g.matchAll(/key_schema \{\s*\n\s*attribute_name = "(\w+)"\s*\n\s*key_type\s*= "(\w+)"/g)];
      if (nested.length) {
        keySchema = nested.map((m) => ({ AttributeName: m[1], KeyType: m[2] }));
      } else {
        keySchema = [
          { AttributeName: gAttr('hash_key'), KeyType: 'HASH' },
          ...(gAttr('range_key') ? [{ AttributeName: gAttr('range_key'), KeyType: 'RANGE' }] : []),
        ];
      }
      return {
        IndexName: gAttr('name'),
        KeySchema: keySchema,
        Projection: { ProjectionType: gAttr('projection_type') || 'ALL' },
      };
    });

    tables.push({
      TableName: name,
      KeySchema: [
        { AttributeName: attr('hash_key'), KeyType: 'HASH' },
        ...(attr('range_key') ? [{ AttributeName: attr('range_key'), KeyType: 'RANGE' }] : []),
      ],
      AttributeDefinitions: attributes,
      ...(gsis.length ? { GlobalSecondaryIndexes: gsis } : {}),
      BillingMode: 'PAY_PER_REQUEST',
    });
  }
}

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(tables, null, 2)}\n`);
console.log(`gen-tables: ${tables.length} tables → ${path.relative(root, outFile)}`);
console.log(`  ${tables.map((t) => t.TableName).join('\n  ')}`);
