// Build VSIX lalu install ke VS Code lokal, hanya jika versi di package.json berbeda dari yang terpasang.
// run: npm run install:local
const { execSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const id = `${pkg.publisher}.${pkg.name}`;
const force = process.argv.includes('--force');

const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

function installedVersion() {
  const list = execSync('code --list-extensions --show-versions', { cwd: root, encoding: 'utf8' });
  const line = list.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${id.toLowerCase()}@`));
  return line?.split('@')[1];
}

const installed = installedVersion();
if (installed === pkg.version && !force) {
  console.log(`[install-local] ${id}@${pkg.version} sudah terpasang. Tidak melakukan apa-apa.`);
  console.log('[install-local] Naikkan version di package.json (npm version patch), atau jalankan dengan -- --force.');
  process.exit(0);
}

console.log(`[install-local] ${id}: ${installed ?? 'belum terpasang'} -> ${pkg.version}`);
run('npm run package');
run(`code --install-extension ${pkg.name}-${pkg.version}.vsix --force`);
console.log('[install-local] Selesai. Jalankan "Developer: Reload Window" di VS Code.');
