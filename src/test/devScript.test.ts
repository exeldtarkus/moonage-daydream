import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** jalankan bagian "database lab" dari scripts/dev.sh (tanpa membuka VS Code) dengan dev-up.sh palsu */
function runDbPart(answer: string | null): { out: string; ran: boolean } {
  const root = mkdtempSync(join(tmpdir(), 'md-dev-'));
  try {
    mkdirSync(join(root, 'docs', 'main', 'temp'), { recursive: true });
    writeFileSync(join(root, 'docs', 'main', 'temp', 'dev-up.sh'), 'echo ran > "$0.done"\n');
    const src = readFileSync(join(__dirname, '..', '..', 'scripts', 'dev.sh'), 'utf8');
    const part = /# database lab lokal[\s\S]*?\nfi\n/.exec(src)?.[0] ?? '';
    assert.ok(part, 'bagian database lab ada di dev.sh');
    const sh = join(root, 'part.sh');
    writeFileSync(sh, `set -euo pipefail\nroot="${root}"\n${part}`);
    const out = execFileSync('bash', [sh], { input: answer ?? '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    let ran = true;
    try { readFileSync(join(root, 'docs', 'main', 'temp', 'dev-up.sh.done')); } catch { ran = false; }
    return { out, ran };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('npm run dev: tanpa terminal interaktif, DB lab tetap dijalankan seperti sebelumnya', () => {
  assert.equal(runDbPart(null).ran, true);
});

test('npm run dev: jawaban "n" melewati container DB lokal', () => {
  const r = runDbPart('n\n');
  assert.equal(r.ran, false);
});

test('npm run dev: jawaban "y" / kosong menjalankan DB lab', () => {
  assert.equal(runDbPart('y\n').ran, true);
  assert.equal(runDbPart('\n').ran, true);
});
