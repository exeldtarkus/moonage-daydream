# TODO

> **▶ LANJUT DARI SINI (2026-10-29, v0.2.0)**
> Selesai: SQLite, MySQL / MariaDB, PostgreSQL, MongoDB, virtual scroll, README + icon + screenshot.
> Berikutnya: publish (butuh token Open VSX di `deployment/vsx/token` / upload manual VSIX ke Marketplace oleh user).
> Alur per TODO: kerjakan → `npm test` + `npm run test:real` (+ `npm run test:servers` untuk driver) → tandai [x] → 1 commit per TODO → push.


## Tahap 1 — inti (selesai, v0.1.0)
- [x] Koneksi SQL Server: add / edit / remove / select (password di SecretStorage)
- [x] Run query dari file `.sql` (`Ctrl+Alt+Enter`, selection atau seluruh file, batch dipisah `GO`)
- [x] Panel hasil: tabel per result set, jumlah baris, durasi, pesan (PRINT / rows affected), error

## Tahap 2 — supaya nyaman
- [x] Lokasi hasil dinamis: panel bawah / kanan / kiri editor (`Move Results To…`), test real: `npm run test:real`
- [x] Koneksi SQL Server named instance (`host\instance`, port via SQL Server Browser)
- [x] Koneksi + database per file `.sql` (CodeLens `Execute | koneksi | database`, status bar ikut file aktif)
- [x] Explorer di sidebar: koneksi → database → tables / views / procedures → kolom, + "Select Top 100"
- [x] Pin hasil ke tab sendiri, pin berikutnya berdampingan (side by side) untuk membandingkan run berbeda
- [x] Export hasil (All Data dari server / Current Selection) ke Excel .xlsx, CSV, JSON, JSON pretty, Markdown, HTML
- [x] Copy ke clipboard: Ctrl+C baris terpilih (TSV), tombol Copy di popup Export (semua format teks)
- [x] Toolbar hasil: filter WHERE (input di atas grid, query dijalankan ulang dengan WHERE tambahan)
- [x] Filter per kolom (ikon filter + menu ⋮ di header kolom: filter nilai, sort, hide) — di baris yang sudah dimuat
- [x] Panel samping hasil: Columns (tampil / sembunyi, cari, lompat ke kolom), Inspector (detail baris terpilih)
- [x] Columns: urutkan ulang kolom (tombol ↑ ↓ / drag), ikut ke filter, sort, edit, export
- [x] Form Add / Edit Connection (tab editor, tombol Test / Save)
- [x] Sidebar Running Queries (cancel per query / cancel all) dan Query History (open, run again, copy, clear)
- [x] Tabel besar: baris di-stream, hanya 1000 pertama disimpan (memori tetap kecil, cancel tetap responsif)
- [x] Cancel query (CodeLens `Cancel` / command, run ulang membatalkan run lama, dihentikan di server)
- [x] Loading: spinner di panel hasil saat query berjalan, "Cancelling…" di CodeLens / Running Queries / notifikasi
- [x] Sidebar SQL Files: semua .sql di workspace, tampilan folder atau list, New SQL File (root / per folder)
- [x] Beberapa SELECT (tanpa variabel / #temp / INTO) dijalankan paralel per statement: hasil tampil per statement, Cancel per statement

## Tahap 3 — nanti
- [x] CodeLens `Execute | Explain | Analyze` per statement (Explain = estimated plan, Analyze = actual plan khusus SELECT, rollback)
- [x] Autocomplete database / schema / tabel / view, termasuk lintas database (`DB.schema.table`, `DB..table`)
- [x] Autocomplete kolom dari tabel di FROM / JOIN (WHERE, SELECT, ON, `alias.`)
- [x] Autocomplete keyword / fungsi SQL, kolom dari FROM dengan koma (`FROM a, b`)
- [x] Formatter SQL (Format Document / Selection, Shift+Alt+F): keyword huruf besar, koma di depan (setting `moonageDaydream.format.*`)
- [x] Klik kanan database di Connections: New SQL File (tab terikat ke koneksi + database)
- [x] Auto limit 100 (setting `moonageDaydream.query.autoLimit`): satu SELECT tanpa TOP / OFFSET FETCH / INTO diambil 100 baris lalu dihentikan di server
- [x] Linter: statement tanpa `;` ditandai merah (setting `moonageDaydream.lint.semicolon`), Quick Fix "Add ;"
- [x] Transaction strategy: mode Auto-commit / Manual per file (Manual = BEGIN TRAN otomatis, tombol Commit / Rollback, status transaksi di status bar, peringatan bila transaksi masih terbuka saat file / koneksi ditutup)
- [x] Edit data di grid: double-click sel -> script UPDATE (BEGIN TRAN, WHERE primary key) di tab baru, tidak dijalankan otomatis
- [x] Paging: tombol Load more (+1000 baris, maks 50.000 di grid)
- [x] Virtual scroll di grid (>300 baris: baris di <template>, hanya sekitar viewport yang dipasang; filter / sort / seleksi / edit tetap atas semua baris)

## Database lain (lewat `src/db.ts` → `drivers`)
- [x] MySQL / MariaDB (mysql2; cancel = KILL QUERY; tanggal sebagai teks)
- [x] PostgreSQL (pg; cancel = pg_cancel_backend)
- [x] SQLite (sql.js wasm inline, file dibaca / ditulis per query; tanpa cancel)
- [x] MongoDB (query gaya mongosh `db.c.find(...)`, explorer database → collection, cancel = killOp; tanpa transaksi manual)
- [x] SQL Server Windows Authentication (NTLM: domain + user + password; SSO user Windows aktif tidak didukung tedious)

## Berikutnya (urut)
- [ ] Transaksi manual SQL Server: script dijalankan sebagai SQL batch (tanpa error 266 untuk COMMIT / ROLLBACK / BEGIN TRAN di script), SELECT tidak membuka transaksi bila belum ada yang terbuka — kode + unit test selesai, menunggu test real (user)
- [ ] Fix UI form New Connection (pilih database): logo menutupi seluruh kartu, nama / deskripsi database terpotong di tepi kanan, layout grid + CSS dirapikan (lihat screenshot 2026-10-29) — CSS logo yang terhapus di 2944b76 dikembalikan + padding search, test layout `docs/main/temp/form-layout-run.sh`, menunggu cek user
- [ ] Hasil statement non-SELECT ikut tampil saat dijalankan bersama SELECT (mis. SELECT + UPDATE sekaligus: panel hanya menampilkan result set SELECT, "n row(s) affected" UPDATE tidak muncul). Cek juga INSERT, DELETE, MERGE, EXEC, DDL; per statement terlihat hasil / jumlah baris terdampak, berjudul "Statement n <SQL>" + pemisah antar blok — kode + unit test selesai, menunggu test real (user)
- [ ] Form koneksi ala DBCode (sidebar kiri: Connection / SSL-TLS / Timeouts / Permissions / Driver settings), per tahap dengan TDD — kode + unit test selesai, menunggu test real (user):
  - [x] Import connection string (ADO SQL Server `Server=..;Database=..`, URL mysql:// mariadb:// postgres:// mongodb(+srv)://) -> isi form
  - [x] Import koneksi DBCode (`dbcode.connections` di user settings): nama, tipe, host, port, user, database, group — tanpa password
  - [x] SSL/TLS + connection timeout per koneksi, dipakai semua driver
  - [x] Permissions: koneksi read-only (hanya statement read-only yang boleh dijalankan)
  - [x] Driver settings: tabel key/value opsi driver yang diteruskan ke driver
  - [x] UI form: sidebar section + panel, layout test (Chromium headless)
- [ ] SQL Server: stored procedure & view dari explorer, per tahap dengan TDD — kode + unit test selesai, menunggu test real (user):
  - [x] Show Definition (OBJECT_DEFINITION) di tab baru terikat koneksi + database
  - [x] Edit: script CREATE OR ALTER di tab baru (dijalankan sendiri dengan Execute, tidak otomatis)
  - [x] Run procedure: script EXEC dengan parameter (tipe, OUTPUT, default), tanpa parameter langsung jalan; view = Select Top 100
  - [x] Node procedure bisa di-expand: daftar parameter
- [ ] MySQL / MariaDB / PostgreSQL: transaksi manual setara SQL Server — kode + unit test + `npm run test:servers` (19/19) selesai, menunggu test real di VS Code (user):
  - [x] status transaksi dibaca dari server (MySQL / MariaDB `@@in_transaction`, PostgreSQL status transaksi sesi) -> COMMIT / ROLLBACK di script terdeteksi, pesan "Transaction committed / rolled back"
  - [x] MySQL / MariaDB: DDL (CREATE / ALTER / DROP ...) = implicit commit -> peringatan + status ikut tertutup
  - [x] PostgreSQL: error di dalam transaksi = transaksi "aborted" (semua statement berikutnya ditolak sampai ROLLBACK) -> beri tahu user, tawarkan Rollback
  - [x] SELECT biasa tidak membuka transaksi bila belum ada yang terbuka
- [ ] MySQL / MariaDB / PostgreSQL: Show Definition, Edit, Run untuk stored procedure / function / view + parameter di explorer — kode + unit test + `npm run test:servers` selesai, menunggu test real di VS Code (user)
  - [x] Body routine utuh saat dipecah per statement (lens Execute / statement di kursor / lint): SQL Server sampai GO, MySQL BEGIN ... END, PostgreSQL $$ ... $$
  - [x] MySQL / MariaDB: SHOW CREATE PROCEDURE / FUNCTION / VIEW, parameter dari information_schema.parameters, Run = CALL p(...) / SELECT f(...)
  - [x] PostgreSQL: pg_get_functiondef / pg_get_viewdef, procedure vs function (CALL vs SELECT), overload (nama sama, argumen beda), parameter dari pg_proc
- [ ] SQL Server: struktur Object Explorer seperti extension mssql (referensi: marketplace ms-mssql.mssql), per tahap dengan TDD — kode + unit test + query terverifikasi di SQL Server 2022 Docker, menunggu test real di VS Code (user):
  - [x] Databases -> subfolder "System Databases" (master, model, msdb, tempdb, distribution; database_id <= 4 / is_distributor) terpisah dari database user
  - [x] Server Objects: Endpoints (sys.endpoints), Linked Servers (sys.servers is_linked; + test koneksi linked server), Triggers server (sys.server_triggers)
  - [x] Security (server): Logins, Server Roles (+ anggota), Credentials, Cryptographic Providers, Audits, Server Audit Specifications
  - [x] Per database: Tables (+ System Tables), Views (+ System Views), Synonyms, Programmability (Stored Procedures, Functions: table-valued / scalar / aggregate, Database Triggers, Types, Sequences), Security (Users, Roles, Schemas)
  - [x] Per tabel: Columns (PK / FK / tipe / null), Keys, Constraints, Triggers, Indexes, Statistics
  - [x] Script as: CREATE / ALTER / DROP / SELECT / INSERT / UPDATE / DELETE untuk tabel, view, procedure, function, trigger (tab baru, tidak dijalankan otomatis)
  - [x] Fungsi / trigger: Show Definition / Edit (CREATE OR ALTER) / Run (SELECT dbo.f(...) / SELECT * FROM dbo.tvf(...)), sama seperti procedure
  - [x] SQL Server Agent: Jobs (status, last run, start / stop job), Job Activity
  - [x] Activity / sesi: sp_who2 / sys.dm_exec_requests (session, blocking, wait, query), kill session (dengan konfirmasi)
  - [x] Info server / database: versi, edition, collation, recovery model, ukuran file data / log
  - [x] Backup / Restore database (dialog, script BACKUP / RESTORE, dengan konfirmasi)
  - [x] Batasan diperbaiki: CREATE TABLE lengkap (identity / computed / default / collation / PK / unique / check / FK / index INCLUDE + filter, uji bolak-balik identik di Docker), INSERT / UPDATE tanpa kolom identity / computed / rowversion, pesan izin (Jobs / Agent / Audits) bukan error merah + status service Agent, System Views per schema, Agent Start / Stop Job teruji (Docker dengan MSSQL_AGENT_ENABLED)
- [ ] SQL Server Live Monitor (grafik live + tabel, refresh 1 / 2 / 5 / 10 / 30 / 60 s, jendela 1 / 5 / 15 menit, Pause), per tahap dengan TDD — kode + unit test + verifikasi Docker selesai, menunggu test real di VS Code (user):
  - [x] Test unit `src/test/monitor.test.ts` (monitorSample, MONITOR_SQL, panel) — hijau
  - [x] `src/monitor.ts`: MONITOR_SQL (satu batch, 7 result set: counters, waiting tasks, io total, wait stats, sessions + blocking, expensive queries, file io), MONITOR_SETS (index), monitorSample(sets, t, prev?) -> { point, sessions, waits, expensive, files }
  - [x] `src/monitorHtml.ts`: webview grafik SVG (CPU %, Batch req/s, Waiting tasks, I/O MB/s, Connections, Transactions/s; tema VS Code), pilihan refresh / window, Pause, tab Sessions / Top waits / Expensive queries / File I/O, Kill Session (konfirmasi), Open as query
  - [x] Panel di extension: command Live Monitor (menu koneksi SQL Server), polling dengan driver.run (tanpa request menumpuk), berhenti saat tab tersembunyi / ditutup, pesan izin VIEW SERVER STATE
  - [x] Verifikasi query + dua sampel nyata di SQL Server Docker (moonage-mssql), screenshot panel (page-check.sh), langkah test real untuk user
  - [x] monitoring bisa di lakukan per db aksesnya click databases -> pilih database -> click kanan pada database yang mau di monitoring
  - [x] makesure monitoring query execute grafiknya jangan include excute query dari laptop user, agar datanya memang bener transaksi yang sedang di lakukan di database / server
  - [x] monitoring menampilkan juga query yang sedang di execute
  - [x] makesure kill pada monitoring bener-bener bekerja
- [ ] Live Monitor MySQL / MariaDB (SHOW GLOBAL STATUS, processlist) dan PostgreSQL (pg_stat_database, pg_stat_activity), per tahap dengan TDD — kode + unit test + verifikasi Docker (MySQL 8.4, MariaDB 11.4, PostgreSQL 16) selesai, menunggu test real di VS Code (user):
  - [x] Panel generik: grafik & tab dari definisi per database (point.values per grafik), SQL Server tetap sama (adapter)
  - [x] MySQL / MariaDB: Queries/s, Transactions/s, Threads connected / running, Network MB/s, InnoDB I/O MB/s, Row lock waits; Running queries / Sessions (processlist), Expensive queries (performance_schema digest, opsional), Kill = KILL <id>; per database (klik kanan database)
  - [x] PostgreSQL: Transactions/s, Rows/s, Disk blocks/s, Cache hit %, Connections, Active / Waiting sessions; Running queries / Sessions (pg_stat_activity + pg_blocking_pids), Expensive queries (pg_stat_statements, opsional), Kill = pg_terminate_backend; per database
  - [x] Verifikasi ke MySQL / MariaDB / PostgreSQL Docker sementara, screenshot panel, langkah test real

## Rilis
- [x] README (EN + ID) + icon + screenshot (`node scripts/screenshots.js`, data contoh)
- [x] Field `repository` di package.json
- [ ] Publish (Open VSX / Marketplace) — butuh token / upload manual oleh user
- [x] Bundle dengan esbuild saat package (VSIX 9 MB / 5000+ file -> 603 KB / 6 file)
