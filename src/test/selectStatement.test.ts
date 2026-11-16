import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ext = readFileSync(join(root, 'src', 'extension.ts'), 'utf8');

test('select statement: CodeLens button instead of double-click', () => {
  assert.ok(ext.includes("command: 'moonageDaydream.selectStatement'"), 'CodeLens entry per statement');
  assert.ok(ext.includes("registerCommand('moonageDaydream.selectStatement'"), 'command registered');
  assert.ok(!ext.includes('expandWordToStatement'), 'double-click selection listener removed');
});

test('select statement: command contributed, hidden from the palette (needs arguments)', () => {
  const cmd = pkg.contributes.commands.find((c: { command: string }) => c.command === 'moonageDaydream.selectStatement');
  assert.ok(cmd, 'command declared');
  const hidden = pkg.contributes.menus.commandPalette.find((m: { command: string }) => m.command === 'moonageDaydream.selectStatement');
  assert.equal(hidden?.when, 'false');
});

test('select statement: the double-click setting is gone', () => {
  assert.ok(!pkg.contributes.configuration.properties['moonageDaydream.editor.doubleClickSelectsStatement'], 'setting removed');
});
