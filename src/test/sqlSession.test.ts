// Transaksi manual MySQL / MariaDB / PostgreSQL (sqlDriver) tanpa server: Link palsu dengan status transaksi seperti protokolnya
// (MySQL: SERVER_STATUS_IN_TRANS, PostgreSQL: ReadyForQuery I / T / E).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { sqlDriver } from '../sqlDriver';
import type { Base, Link, Raw } from '../sqlDriver';
import type { ConnectionInfo } from '../db';

type State = 'idle' | 'open' | 'failed';

function fake(dialect: 'mysql' | 'postgres', withState = true) {
  const server = { state: 'idle' as State, log: [] as string[] };
  const link: Link = {
    async exec(sql) {
      const raw: Raw = { sets: [], affected: [] };
      for (const st of sql.split(';').map((s) => s.trim().toUpperCase()).filter(Boolean)) {
        server.log.push(st);
        if (server.state === 'failed' && !/^(ROLLBACK|COMMIT)/.test(st)) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
        if (st === 'BEGIN') server.state = 'open';
        else if (st === 'COMMIT' || st === 'ROLLBACK') server.state = 'idle'; // PostgreSQL: COMMIT di transaksi aborted = ROLLBACK
        else if (st.startsWith('CREATE ')) {
          if (dialect === 'mysql') server.state = 'idle'; // DDL = implicit commit
        } else if (st === 'FAIL') {
          if (dialect === 'postgres' && server.state === 'open') server.state = 'failed';
          throw new Error('boom');
        } else if (st.startsWith('SELECT')) raw.sets.push({ columns: ['a'], types: ['int'], rows: [[1]] });
        else if (st.startsWith('UPDATE')) raw.affected.push(1);
        else throw new Error(`fake server: ${st}`);
      }
      return raw;
    },
    async release() {},
    ...(withState ? { txState: async () => server.state } : {}),
  };
  const base = { label: dialect, dialect, dedicated: async () => link, link: async () => link } as unknown as Base;
  const conn = { name: 'n', type: dialect, host: 'h', port: 1, user: 'u', database: 'd', trustServerCertificate: false } as ConnectionInfo;
  return { server, session: () => sqlDriver(base).session(conn, 'pw') };
}

test('sql session: SELECT without an open transaction runs without BEGIN, UPDATE opens, SELECT runs inside', async () => {
  const { server, session } = fake('postgres');
  const s = await session();
  await s.run('SELECT 1');
  assert.ok(!s.open && !server.log.includes('BEGIN'), 'SELECT alone: no transaction');
  await s.run('UPDATE t SET a = 1');
  assert.ok(s.open, 'UPDATE opens');
  await s.run('SELECT 1');
  assert.ok(s.open);
  assert.equal(server.log.filter((l) => l === 'BEGIN').length, 1);
  await s.commit();
  assert.ok(!s.open && server.state === 'idle');
  await s.close();
});

test('sql session: COMMIT / ROLLBACK in the script read from the server state', async () => {
  const { server, session } = fake('mysql');
  const s = await session();
  await s.run('UPDATE t SET a = 1');
  await s.run('COMMIT');
  assert.ok(!s.open, 'COMMIT in the script closes the transaction');
  await s.commit(); // tidak ada yang terbuka: tidak mengirim apa pun
  assert.equal(server.log.filter((l) => l === 'COMMIT').length, 1);
  await s.run('UPDATE t SET a = 1');
  await s.run('ROLLBACK');
  assert.ok(!s.open);
  await s.close();
});

test('sql session: MySQL DDL commits implicitly, the session sees the transaction closed', async () => {
  const { session } = fake('mysql');
  const s = await session();
  await s.run('UPDATE t SET a = 1');
  await s.run('CREATE TABLE x (a INT)');
  assert.ok(!s.open, 'implicit commit');
  await s.close();
  const pg = await fake('postgres').session();
  await pg.run('UPDATE t SET a = 1');
  await pg.run('CREATE TABLE x (a INT)');
  assert.ok(pg.open, 'PostgreSQL DDL is transactional');
  await pg.close();
});

test('sql session: PostgreSQL error aborts the transaction; Commit refuses and rolls back', async () => {
  const { server, session } = fake('postgres');
  const s = await session();
  await s.run('UPDATE t SET a = 1');
  await assert.rejects(s.run('FAIL'), /boom/);
  assert.ok(s.open && s.failed, 'aborted transaction is still open, flagged failed');
  await assert.rejects(s.run('SELECT 1'), /aborted/);
  await assert.rejects(s.commit(), /aborted.*rolled back/i);
  assert.ok(!s.open && !s.failed && server.state === 'idle');
  await s.close();
});

test('sql session: transaction lost (connection reset) is reported, nothing run', async () => {
  const { server, session } = fake('mysql');
  const s = await session();
  await s.run('UPDATE t SET a = 1');
  server.state = 'idle'; // koneksi dibuat ulang / transaksi hilang di server
  const before = server.log.length;
  await assert.rejects(s.run('UPDATE t SET a = 2'), /lost/);
  assert.equal(server.log.length, before, 'nothing sent');
  assert.ok(!s.open);
  await s.close();
});

test('sql session: link without server state (SQLite) keeps the client-side tracking', async () => {
  const { server, session } = fake('mysql', false);
  const s = await session();
  await s.run('SELECT 1');
  assert.ok(!s.open, 'SELECT opens no transaction');
  await s.run('UPDATE t SET a = 1');
  assert.ok(s.open && server.log.includes('BEGIN'));
  await s.commit();
  assert.ok(!s.open && server.log.at(-1) === 'COMMIT');
  await s.close();
});
