// Bangun media/db-on/<type>.svg: logo database (media/db) + titik hijau berdenyut di pojok kanan-bawah = koneksi terhubung.
// Logo di sekitar titik dipotong (mask) supaya titik terbaca di tema terang maupun gelap. run: node scripts/conn-icons.js
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'media', 'db');
const out = path.join(__dirname, '..', 'media', 'db-on');
fs.mkdirSync(out, { recursive: true });

for (const file of fs.readdirSync(src).filter((f) => f.endsWith('.svg'))) {
  const logo = fs.readFileSync(path.join(src, file), 'utf8');
  const viewBox = /viewBox="([^"]+)"/.exec(logo)?.[1];
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(logo)?.[1];
  if (!viewBox || !inner) throw new Error(`${file}: <svg viewBox> tidak ditemukan`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <style>
    .wave { transform-origin: 12px 12px; animation: wave 1.8s ease-out infinite; }
    @keyframes wave { from { transform: scale(1); opacity: .8; } to { transform: scale(1.6); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .wave { animation: none; opacity: 0; } }
  </style>
  <mask id="cut"><rect width="16" height="16" fill="#fff"/><circle cx="12" cy="12" r="4" fill="#000"/></mask>
  <g mask="url(#cut)"><svg width="16" height="16" viewBox="${viewBox}">${inner}</svg></g>
  <circle class="wave" cx="12" cy="12" r="2.6" fill="none" stroke="#3fb950" stroke-width="1" vector-effect="non-scaling-stroke"/>
  <circle cx="12" cy="12" r="2.6" fill="#3fb950"/>
</svg>
`;
  fs.writeFileSync(path.join(out, file), svg);
  console.log(`media/db-on/${file}`);
}
