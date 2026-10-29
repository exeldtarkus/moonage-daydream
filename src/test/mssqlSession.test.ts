// Transaksi manual SQL Server tanpa server: ConnectionPool mssql diganti server palsu yang hanya mengerti
// BEGIN TRAN / COMMIT / ROLLBACK / SELECT @@TRANCOUNT, cukup untuk memeriksa status dari @@TRANCOUNT.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import * as sql from 'mssql';
import { mssqlDriver } from '../mssql';
import type { ConnectionInfo } from '../db';

const server = { n: 0, spid: 51, log: [] as string[] };

/** satu statement palsu; mengembalikan baris untuk SELECT @@TRANCOUNT */
function exec(text: string): number[][] | undefined {
  const t = text.trim().toUpperCase();
  server.log.push(t);
  if (t === 'BEGIN TRAN') server.n++;
  else if (t === 'WHILE @@TRANCOUNT > 0 COMMIT TRAN') server.n = 0;
  else if (t === 'COMMIT') server.n = Math.max(0, server.n - 1);
  else if (t === 'ROLLBACK' || t === 'IF @@TRANCOUNT > 0 ROLLBACK TRAN') {
    server.n = 0;
    activeTx?.emit('rollback', true); // ENVCHANGE rollback: node-mssql memberi tahu Transaction
  }
  else if (t.startsWith('SELECT @@TRANCOUNT')) return [[server.n]];
  else if (t !== 'UPDATE T') throw new Error(`fake server: ${t}`);
  return undefined;
}

class FakeRequest extends EventEmitter {
  arrayRowMode = false;
  stream = false;
  cancel() {}
  pause() {}
  resume() {}
  batch(text: string) {
    return Promise.resolve().then(() => void exec(text));
  }
  // dengan callback = mode stream (collect); tanpa = state() (SELECT @@TRANCOUNT AS n, @@SPID AS spid)
  query(text: string, done?: (e: unknown, r?: unknown) => void): unknown {
    if (!done) return Promise.resolve({ recordset: [{ n: server.n, spid: server.spid }] });
    setImmediate(() => {
      try {
        for (const st of text.split(';').filter((s) => s.trim())) {
          const rows = exec(st);
          if (rows) {
            this.emit('recordset', [{ name: 'tc' }]);
            rows.forEach((r) => this.emit('row', r));
          }
        }
        done(null, { rowsAffected: [] });
      } catch (e) {
        this.emit('error', e);
        done(e);
      }
    });
    return undefined;
  }
}

class FakePool {
  async connect() { return this; }
  request() { return new FakeRequest(); }
  async close() {}
}
/**
 * sql.Transaction palsu dengan perilaku node-mssql (lib/tedious/transaction.js): commit hanya satu level,
 * COMMIT di script tidak terdeteksi, hanya rollback dari server yang memicu event 'rollback'.
 * Tidak dipakai implementasi sekarang; ada supaya test tetap bermakna terhadap implementasi berbasis sql.Transaction.
 */
let activeTx: FakeTransaction | undefined;
class FakeTransaction extends EventEmitter {
  async begin() {
    exec('BEGIN TRAN');
    activeTx = this;
  }
  async commit() {
    if (server.n === 0) throw new Error('The COMMIT TRANSACTION request has no corresponding BEGIN TRANSACTION.');
    server.n--;
  }
  async rollback() {
    server.n = 0;
  }
}
const fakeSql = sql as unknown as Record<string, unknown>;
fakeSql.ConnectionPool = FakePool;
fakeSql.Transaction = FakeTransaction;
fakeSql.Request = FakeRequest;

const conn: ConnectionInfo = { name: 'fake', type: 'mssql', host: 'h', port: 1433, user: 'u', database: 'db', trustServerCertificate: true };
const tc = async (s: { run(t: string): Promise<{ resultSets: { rows: unknown[][] }[] }> }) => (await s.run('SELECT @@TRANCOUNT AS tc')).resultSets[0].rows[0][0];

const fresh = () => {
  Object.assign(server, { n: 0, spid: 51, log: [] });
  return mssqlDriver.session(conn, 'pw');
};

test('mssql session: BEGIN TRAN once, kept open across runs', async () => {
  const s = await fresh();
  assert.equal(await tc(s), 1, 'first run opens the transaction');
  assert.ok(s.open);
  assert.equal(await tc(s), 1, 'next run: no second BEGIN TRAN');
  assert.equal(server.log.filter((l) => l === 'BEGIN TRAN').length, 1);
  await s.close();
});

test('mssql session: Commit closes a nested BEGIN TRAN from the script (every level)', async () => {
  const s = await fresh();
  await s.run('BEGIN TRAN');
  assert.equal(await tc(s), 2, 'nested BEGIN TRAN in the script');
  await s.commit();
  assert.equal(server.n, 0, 'commit closes every level');
  assert.ok(!s.open);
  assert.equal(await tc(s), 1, 'after commit: new transaction, not nested');
  await s.close();
});

test('mssql session: COMMIT / ROLLBACK in the script close the transaction', async () => {
  const s = await fresh();
  await s.run('UPDATE T');
  await s.run('COMMIT');
  assert.ok(!s.open, 'COMMIT in the script closes the transaction');
  await s.commit(); // tidak ada yang terbuka: tidak mengirim apa pun, tidak error
  await s.run('UPDATE T');
  await s.run('ROLLBACK');
  assert.ok(!s.open, 'ROLLBACK in the script');
  await s.close();
});

test('mssql session: lost connection is reported, never silently committed or re-begun', async () => {
  const s = await fresh();
  await s.run('UPDATE T');
  assert.ok(s.open);

  // pool membuat koneksi baru: spid lain, transaksi sudah di-rollback server
  Object.assign(server, { n: 0, spid: 52 });
  await assert.rejects(s.commit(), /lost/);
  assert.ok(!s.open);
  assert.ok(!server.log.includes('WHILE @@TRANCOUNT > 0 COMMIT TRAN'), 'commit not sent to the new connection');

  await s.run('UPDATE T'); // run berikutnya: transaksi baru di koneksi baru
  Object.assign(server, { n: 0, spid: 53 });
  const before = server.log.length;
  await assert.rejects(s.run('UPDATE T'), /lost/);
  assert.ok(!server.log.slice(before).includes('UPDATE T'), 'nothing run after the transaction was lost');
  await s.close();
});

test('mssql session: failed commit keeps the transaction open when the server says so', async () => {
  const s = await fresh();
  await s.run('UPDATE T');
  const fake = FakeRequest.prototype.batch;
  FakeRequest.prototype.batch = () => Promise.reject(new Error('connection lost'));
  try {
    await assert.rejects(s.commit(), /connection lost/);
  } finally {
    FakeRequest.prototype.batch = fake;
  }
  assert.ok(s.open, '@@TRANCOUNT still 1: still open, Commit / Rollback still available');
  await s.rollback();
  assert.ok(!s.open);
  await s.close();
});
