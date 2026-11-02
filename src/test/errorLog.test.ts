import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// test dijalankan dari out/test: sumber TypeScript ada di ../../src
const SRC = join(__dirname, '..', '..', 'src');
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('Html.ts'));

test('every catch logs an ERROR, rethrows, or says in a comment why it is ignored', () => {
  const bad: string[] = [];
  for (const f of files) {
    const lines = readFileSync(join(SRC, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\bcatch\s*\(|\.catch\(/.test(line)) return;
      const block = lines.slice(i, i + 6).join('\n');
      if (!/\.error\(|\bthrow\b|\/\//.test(block)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('every error notification has a Show Log button', () => {
  const bad: string[] = [];
  for (const f of files) {
    readFileSync(join(SRC, f), 'utf8').split('\n').forEach((line, i) => {
      if (line.includes('showErrorMessage(') && !line.includes("'Show Log'")) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});
