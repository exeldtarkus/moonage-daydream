// Publish extension ke Open VSX (https://open-vsx.org).
// run: npm run deploy                 (token diminta sekali, lalu disimpan di deployment/vsx/token)
//      npm run deploy -- --new-token  (masukkan ulang token, mis. jika expired)
const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const tokenDir = path.join(root, 'deployment', 'vsx');
const tokenFile = path.join(tokenDir, 'token');
const registry = 'https://open-vsx.org';
const vsix = `${pkg.name}-${pkg.version}.vsix`;

const log = (msg) => console.log(`[deploy] ${msg}`);

function fail(msg) {
  console.error(`[deploy] ${msg}`);
  process.exit(1);
}

/** Token dikirim lewat env OVSX_PAT agar tidak terlihat di daftar proses. */
function run(cmd, token) {
  execSync(cmd, { cwd: root, stdio: 'inherit', env: token ? { ...process.env, OVSX_PAT: token } : process.env });
}

/** Status HTTP dari GET ke API Open VSX (200 = ada, 404 = belum ada). */
function apiStatus(urlPath) {
  return new Promise((resolve, reject) => {
    https.get(`${registry}/api/${urlPath}`, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

/** Baca input tanpa menampilkan karakter yang diketik. */
function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(input.trim());
          return;
        }
        if (ch === '\u0003') {
          stdout.write('\n');
          process.exit(130); // Ctrl+C
        }
        input = ch === '\u007f' || ch === '\b' ? input.slice(0, -1) : input + ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function getToken() {
  if (!process.argv.includes('--new-token') && fs.existsSync(tokenFile)) {
    const saved = fs.readFileSync(tokenFile, 'utf8').trim();
    if (saved) {
      log(`Memakai token dari ${path.relative(root, tokenFile)}`);
      return saved;
    }
  }
  if (!process.stdin.isTTY) {
    fail(`Token belum ada di ${path.relative(root, tokenFile)} dan terminal tidak interaktif.`);
  }
  const token = await askHidden('Open VSX access token (open-vsx.org → Settings → Access Tokens): ');
  if (!token) {
    fail('Token kosong, dibatalkan.');
  }
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  log(`Token disimpan di ${path.relative(root, tokenFile)}`);
  return token;
}

async function main() {
  const namespace = pkg.publisher;
  const id = `${namespace}.${pkg.name}@${pkg.version}`;

  if ((await apiStatus(`${namespace}/${pkg.name}/${pkg.version}`)) === 200) {
    log(`${id} sudah ada di Open VSX. Tidak melakukan apa-apa.`);
    log('Naikkan version di package.json (npm version patch) untuk rilis baru.');
    return;
  }

  const token = await getToken();

  if ((await apiStatus(namespace)) === 404) {
    log(`Namespace '${namespace}' belum ada, membuat...`);
    run(`npx ovsx create-namespace ${namespace}`, token);
  }
  log(`Memeriksa token untuk namespace '${namespace}'...`);
  try {
    run(`npx ovsx verify-pat ${namespace}`, token);
  } catch (err) {
    fail(`Token tidak valid untuk namespace ini (${err.message}). Jalankan ulang dengan: npm run deploy -- --new-token`);
  }

  run('npm test');
  run('npm run package');
  log(`Publish ${vsix}...`);
  run(`npx ovsx publish ${vsix}`, token);
  log(`Selesai: ${registry}/extension/${namespace}/${pkg.name}`);
}

main().catch((err) => fail(err.message));
