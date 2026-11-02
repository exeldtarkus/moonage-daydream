import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { drivers, dropConfirm, dropTarget, type ConnectionInfo } from '../db';
import { deleteSqliteFile } from '../sqlite';

const conn: ConnectionInfo = { name: 'local', type: 'mssql', host: 'h', port: 1, user: 'u', database: '', trustServerCertificate: true };

test('drop: SQL Server Drop Database script (single user, quoted name) and system databases', () => {
  const dd = drivers.mssql.dropDatabase!;
  assert.equal(dd.script('sh]op'), 'ALTER DATABASE [sh]]op] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\nDROP DATABASE [sh]]op];');
  assert.deepEqual(dd.system, ['master', 'model', 'msdb', 'tempdb']);
  assert.ok(!dd.inside);
});

test('drop: SQL Server Drop Table script (schema + name quoted)', () => {
  assert.equal(drivers.mssql.dropTable!({ schema: 'd]bo', name: 'order]item' }), 'DROP TABLE [d]]bo].[order]]item];');
});

test('drop: target connection never uses the dropped database', () => {
  const ms = { defaultDb: 'master', dropDatabase: { script: () => '' } };
  assert.equal(dropTarget(conn, 'shop', ms).database, 'master');
  assert.equal(dropTarget({ ...conn, database: 'other' }, 'shop', ms).database, 'other');
  assert.equal(dropTarget({ ...conn, database: 'shop' }, 'shop', ms).database, 'master');
  const pg = { defaultDb: 'postgres', dropDatabase: { script: () => '' } };
  assert.equal(dropTarget({ ...conn, database: 'postgres' }, 'postgres', pg).database, 'template1');
  assert.equal(dropTarget(conn, 'postgres', pg).database, 'template1');
  // MongoDB: dijalankan di database itu sendiri
  assert.equal(dropTarget({ ...conn, database: 'x' }, 'shop', { defaultDb: 'admin', dropDatabase: { script: () => '', inside: true } }).database, 'shop');
  assert.equal(dropTarget(conn, 'shop', ms).name, 'local');
});

test('drop: confirmation message and detail', () => {
  assert.deepEqual(dropConfirm('database', 'shop', 'local', 'DROP DATABASE [shop];'), {
    message: 'Drop database shop on local?',
    detail: 'This permanently deletes the database and all its data. It cannot be undone.\n\nDROP DATABASE [shop];',
  });
  assert.deepEqual(dropConfirm('table', 'dbo.t', 'local / shop', 'DROP TABLE [dbo].[t];'), {
    message: 'Drop table dbo.t on local / shop?',
    detail: 'This permanently deletes the table and all its rows. It cannot be undone.\n\nDROP TABLE [dbo].[t];',
  });
});

test('drop: SQLite database file is deleted; a directory or missing path is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'md-drop-'));
  try {
    const f = join(dir, 'a.db');
    writeFileSync(f, 'x');
    await deleteSqliteFile(f);
    assert.ok(!existsSync(f));
    await assert.rejects(deleteSqliteFile(dir), /not a file/);
    await assert.rejects(deleteSqliteFile(join(dir, 'missing.db')));
    assert.ok(existsSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('menus: Drop Database on database nodes, Drop Table on table nodes, hidden from the palette', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const items: { command: string; when?: string; group?: string }[] = pkg.contributes.menus['view/item/context'];
  const shown = (cmd: string, viewItem: string) => items.some((it) => it.command === cmd
    && new RegExp(/viewItem =~ \/(.+?)\/(?:\s|$)/.exec(it.when ?? '')![1]).test(viewItem));
  const db = 'moonageDaydream.dropDatabase';
  const tb = 'moonageDaydream.dropTable';
  for (const v of ['db', 'db.mssql', 'db.live']) assert.ok(shown(db, v), v);
  for (const v of ['conn.mssql.on', 'dbx', 'table']) assert.ok(!shown(db, v), v);
  for (const v of ['table', 'table.def', 'table.def.ms.cols', 'table.cols']) assert.ok(shown(tb, v), v);
  for (const v of ['tables', 'view.def', 'db', 'folder.table']) assert.ok(!shown(tb, v), v);
  assert.ok(items.filter((it) => it.command === db || it.command === tb).every((it) => it.group?.startsWith('9_delete')));
  const cmds: { command: string; title: string; icon?: string }[] = pkg.contributes.commands;
  assert.ok(cmds.some((c) => c.command === db && c.title === 'Drop Database…' && c.icon === '$(trash)'));
  assert.ok(cmds.some((c) => c.command === tb && c.title === 'Drop Table…' && c.icon === '$(trash)'));
  const palette: { command: string; when?: string }[] = pkg.contributes.menus.commandPalette;
  for (const c of [db, tb]) assert.ok(palette.some((p) => p.command === c && p.when === 'false'), c);
});
