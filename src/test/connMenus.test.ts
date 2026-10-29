import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

type Item = { command: string; when?: string; group?: string };
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
const items: Item[] = pkg.contributes.menus['view/item/context'];

/** evaluasi bagian viewItem dari klausa when (=~ /regex/ atau == nilai) untuk view explorer */
function shown(it: Item, viewItem: string): boolean {
  const w = it.when ?? '';
  if (!w.includes('view == moonageDaydream.explorer')) return false;
  const re = /viewItem =~ \/(.+?)\/(?:\s|$)/.exec(w);
  if (re) return new RegExp(re[1]).test(viewItem);
  const eq = /viewItem == ([\w.]+)/.exec(w);
  return eq ? eq[1] === viewItem : false;
}
const menu = (viewItem: string, inline: boolean) =>
  items.filter((it) => shown(it, viewItem) && (it.group === 'inline') === inline).map((it) => it.command).sort();

test('connection row: inline Connect icon when disconnected, Disconnect icon when connected', () => {
  for (const kind of ['conn', 'conn.mssql', 'conn.live', 'conn.consul']) {
    assert.ok(menu(`${kind}.off`, true).includes('moonageDaydream.connect'), `${kind}.off has Connect icon`);
    assert.ok(!menu(`${kind}.off`, true).includes('moonageDaydream.disconnect'), `${kind}.off has no Disconnect icon`);
    assert.ok(menu(`${kind}.on`, true).includes('moonageDaydream.disconnect'), `${kind}.on has Disconnect icon`);
    assert.ok(!menu(`${kind}.on`, true).includes('moonageDaydream.connect'), `${kind}.on has no Connect icon`);
  }
});

test('connection row: right-click menu keeps every other item in both states', () => {
  const others = (v: string) => menu(v, false).filter((c) => !/\.(connect|disconnect)$/.test(c));
  for (const kind of ['conn', 'conn.mssql', 'conn.live', 'conn.consul']) {
    assert.ok(others(`${kind}.on`).length >= 5, `${kind}: has its menu items`);
    assert.deepEqual(others(`${kind}.on`), others(`${kind}.off`), `${kind}: same items connected / disconnected`);
  }
  assert.ok(menu('conn.mssql.on', false).includes('moonageDaydream.liveMonitor'), 'SQL Server keeps Live Monitor');
  assert.ok(menu('conn.consul.off', false).includes('moonageDaydream.consulNewKey'), 'Consul keeps New Key');
  assert.ok(!menu('conn.on', false).includes('moonageDaydream.liveMonitor'), 'SQLite has no Live Monitor');
});
