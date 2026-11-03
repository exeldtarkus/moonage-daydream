import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { RELEASES, shouldShow, whatsNewHtml } from '../whatsNew';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));

test('whats new: releases newest first, each with a date and items', () => {
  const num = (v: string) => v.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0);
  for (let i = 1; i < RELEASES.length; i++) assert.ok(num(RELEASES[i - 1].version) > num(RELEASES[i].version), RELEASES[i].version);
  for (const r of RELEASES) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.items.length > 0, r.version);
  }
});

test('whats new: opens until the latest release notes were seen once', () => {
  assert.equal(shouldShow(undefined, RELEASES), true);
  assert.equal(shouldShow(RELEASES[0].version, RELEASES), false);
  assert.equal(shouldShow('0.0.1', RELEASES), true);
  assert.equal(shouldShow(undefined, []), false);
});

test('whats new: page shows the installed version, latest release open, older ones folded, text escaped', () => {
  const html = whatsNewHtml('vscode-resource:', '0.6.5', [
    { version: '0.6.5', date: '2026-10-30', items: [{ kind: 'new', title: 'A <b>', detail: 'x & y' }] },
    { version: '0.6.4', date: '2026-10-30', items: [{ kind: 'fixed', title: 'B' }] },
  ]);
  assert.match(html, /Version <b>0\.6\.5<\/b> installed/);
  assert.match(html, /<details open[^>]*>\s*<summary[^>]*>[\s\S]*0\.6\.5/);
  assert.match(html, /<details(?! open)[^>]*>\s*<summary[^>]*>[\s\S]*0\.6\.4/);
  assert.match(html, /A &lt;b&gt;/);
  assert.match(html, /x &amp; y/);
  assert.doesNotMatch(html, /<script/);
});

test('whats new: command is contributed', () => {
  const cmds = pkg.contributes.commands.map((c: { command: string }) => c.command);
  assert.ok(cmds.includes('moonageDaydream.whatsNew'));
});

test('whats new: notes for 1.0.0 (composite keys, GO n, Mongo hosts, export streaming, Show Log) and 1.1.0', () => {
  const r1 = RELEASES.find((r) => r.version === '1.0.0');
  assert.ok(r1, '1.0.0');
  const text = r1.items.map((i) => `${i.title} ${i.detail ?? ''}`).join('\n');
  for (const word of [/Keys/, /GO n/, /replica set/i, /[Ee]xport/, /Show Log/]) assert.match(text, word);
  assert.ok(RELEASES.find((r) => r.version === '1.1.0'), '1.1.0');
});
