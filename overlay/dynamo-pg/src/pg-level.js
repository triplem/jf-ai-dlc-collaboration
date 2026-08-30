'use strict';

// abstract-level implementation on a single PostgreSQL table.
//
// Dynalite drives this store with utf8 string keys (its own '~'-separated
// prefixes + hex-encoded lexi keys) and JSON-string values, so a TEXT key
// column is safe. COLLATE "C" is load-bearing: range iteration must order keys
// bytewise (like LevelDB), not by locale.

const { AbstractLevel, AbstractIterator } = require('abstract-level');
const { Pool } = require('pg');

const PAGE_SIZE = 200;

class PgIterator extends AbstractIterator {
  #db;
  #options;
  #buffer = [];
  #cursor = null; // last key served — keyset pagination
  #done = false;

  constructor(db, options) {
    super(db, options);
    this.#db = db;
    this.#options = options;
  }

  async #fetchPage() {
    const { gt, gte, lt, lte, reverse, limit } = this.#options;
    const where = [];
    const params = [];
    const add = (cond, value) => {
      params.push(value);
      where.push(`key ${cond} $${params.length}`);
    };
    if (gt != null) add('>', gt);
    if (gte != null) add('>=', gte);
    if (lt != null) add('<', lt);
    if (lte != null) add('<=', lte);
    if (this.#cursor != null) add(reverse ? '<' : '>', this.#cursor);

    let pageSize = PAGE_SIZE;
    if (limit != null && limit >= 0) {
      // abstract-level enforces the limit too; capping here just avoids
      // overfetching on the final page.
      pageSize = Math.min(pageSize, limit);
    }
    const sql = `SELECT key, value FROM kv${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY key ${reverse ? 'DESC' : 'ASC'} LIMIT ${pageSize}`;
    const { rows } = await this.#db.pool.query(sql, params);
    if (rows.length < pageSize) this.#done = true;
    if (rows.length) this.#cursor = rows[rows.length - 1].key;
    this.#buffer = rows;
  }

  async _next() {
    if (!this.#buffer.length && !this.#done) await this.#fetchPage();
    const row = this.#buffer.shift();
    if (!row) return undefined;
    return [row.key, row.value];
  }
}

class PgLevel extends AbstractLevel {
  #connectionString;
  pool = null;

  constructor(location, options) {
    const { valueEncoding, keyEncoding, ...forward } = options || {};
    super(
      {
        encodings: { utf8: true },
        permanence: true,
        seek: false,
        createIfMissing: true,
        errorIfExists: false,
        snapshots: false,
      },
      { valueEncoding, keyEncoding, ...forward },
    );
    this.#connectionString = location;
  }

  async _open() {
    this.pool = new Pool({ connectionString: this.#connectionString });
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS kv (key TEXT COLLATE "C" PRIMARY KEY, value TEXT NOT NULL)',
    );
  }

  async _close() {
    await this.pool?.end();
    this.pool = null;
  }

  async _get(key) {
    const { rows } = await this.pool.query('SELECT value FROM kv WHERE key = $1', [key]);
    return rows[0]?.value; // undefined = not found (abstract-level contract)
  }

  async _getMany(keys) {
    const { rows } = await this.pool.query('SELECT key, value FROM kv WHERE key = ANY($1)', [keys]);
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    return keys.map((k) => byKey.get(k));
  }

  async _put(key, value) {
    await this.pool.query(
      'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, value],
    );
  }

  async _del(key) {
    await this.pool.query('DELETE FROM kv WHERE key = $1', [key]);
  }

  async _batch(operations) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const op of operations) {
        if (op.type === 'put') {
          await client.query(
            'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
            [op.key, op.value],
          );
        } else {
          await client.query('DELETE FROM kv WHERE key = $1', [op.key]);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  _iterator(options) {
    return new PgIterator(this, options);
  }
}

module.exports = { PgLevel };
