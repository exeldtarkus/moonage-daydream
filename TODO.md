# TODO

## Tahap 1 — inti (selesai, v0.1.0)
- [x] Koneksi SQL Server: add / edit / remove / select (password di SecretStorage)
- [x] Run query dari file `.sql` (`Ctrl+Alt+Enter`, selection atau seluruh file, batch dipisah `GO`)
- [x] Panel hasil: tabel per result set, jumlah baris, durasi, pesan (PRINT / rows affected), error

## Tahap 2 — supaya nyaman
- [x] Lokasi hasil dinamis: panel bawah / kanan / kiri editor (`Move Results To…`), test real: `npm run test:real`
- [x] Koneksi SQL Server named instance (`host\instance`, port via SQL Server Browser)
- [x] Koneksi + database per file `.sql` (CodeLens `Execute | koneksi | database`, status bar ikut file aktif)
- [x] Explorer di sidebar: koneksi → database → tables / views / procedures → kolom, + "Select Top 100"
- [ ] Hasil banyak query **side by side** (pembeda dari DBCode), plus pin hasil
- [ ] Export hasil ke CSV / JSON, copy ke clipboard
- [x] Form Add / Edit Connection (tab editor, tombol Test / Save)
- [x] Sidebar Running Queries (cancel per query / cancel all) dan Query History (open, run again, copy, clear)
- [x] Tabel besar: baris di-stream, hanya 1000 pertama disimpan (memori tetap kecil, cancel tetap responsif)
- [x] Cancel query (CodeLens `Cancel` / command, run ulang membatalkan run lama, dihentikan di server)
- [x] Loading: spinner di panel hasil saat query berjalan, "Cancelling…" di CodeLens / Running Queries / notifikasi
- [x] Sidebar SQL Files: semua .sql di workspace, tampilan folder atau list, New SQL File (root / per folder)
- [x] Beberapa SELECT (tanpa variabel / #temp / INTO) dijalankan paralel per statement: hasil tampil per statement, Cancel per statement

## Tahap 3 — nanti
- [ ] CodeLens `Execute` per statement (sekarang satu di baris pertama: selection / seluruh file), Explain / Analyze
- [x] Autocomplete database / schema / tabel / view, termasuk lintas database (`DB.schema.table`, `DB..table`)
- [ ] Autocomplete kolom (setelah alias `a.`) + keyword SQL
- [ ] Edit data langsung di grid
- [ ] Riwayat query
- [ ] Paging / virtual scroll di grid (sekarang 1000 baris pertama per result set; sisanya hanya dihitung)

## Database lain (lewat `src/db.ts` → `drivers`)
- [ ] MySQL / MariaDB
- [ ] PostgreSQL
- [ ] SQLite
- [ ] SQL Server Windows Authentication

## Rilis
- [ ] README + icon + screenshot
- [ ] Field `repository` di package.json, lalu publish (Open VSX / Marketplace)
- [ ] Bundle dengan esbuild (VSIX sekarang 9 MB / 5000+ file karena node_modules mssql)
