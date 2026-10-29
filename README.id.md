# Moonage Daydream

[English](README.md) | Bahasa Indonesia

Database client untuk VS Code: SQL Server, MySQL / MariaDB, PostgreSQL, SQLite dan MongoDB. Tulis query di file `.sql`, jalankan dengan shortcut atau CodeLens, lalu lihat, filter, edit dan export hasilnya di grid.

![Grid hasil dengan tag tipe kolom, baris terpilih, toolbar WHERE dan Load more](images/screenshots/results.png)

## Fitur

- **Lima jenis database**:
  - **SQL Server**: SQL login atau Windows authentication (NTLM dengan domain), named instance lewat SQL Server Browser, opsi *trust server certificate*, pemisah batch `GO`.
  - **MySQL / MariaDB** (mysql2) dan **PostgreSQL** (pg).
  - **SQLite** (sql.js, WebAssembly): file database dibaca setiap query dan ditulis balik setelah statement yang mengubah data.
  - **MongoDB**: query gaya mongosh seperti `db.users.find({ age: { $gt: 30 } }).sort({ name: 1 }).limit(10);`, plus `aggregate`, `countDocuments`, `distinct`, insert / update / delete, `db.getCollection(...)` dan `db.runCommand(...)`. Dokumen ditampilkan sebagai kolom grid. Host boleh berupa connection string `mongodb://` atau `mongodb+srv://`.
- **View Connections**: koneksi → database → Tables / Views / Procedures → kolom. **Select Top 100** pada table atau view, **New SQL File** pada database. Password disimpan di SecretStorage VS Code.
- **Koneksi dan database per file**, tampil dan bisa diganti lewat CodeLens di atas file.
- **Run**: selection, atau statement di posisi kursor. CodeLens per statement: **Execute**, **Explain**, **Analyze** (hanya SELECT). Beberapa SELECT yang dipilih bersamaan berjalan paralel. Query yang sedang berjalan bisa di-cancel di server.
- **Auto limit** untuk satu SELECT, lalu **Load more (+1000)** sampai 50.000 baris di grid.
- **Mode transaksi manual** per file dengan lens **Commit** / **Rollback**.
- **Grid hasil**: tag tipe kolom, toolbar WHERE yang menjalankan ulang query di server, filter / sort / hide per kolom pada baris yang sudah dimuat, urutan kolom bisa diubah, panel samping **Columns** / **Inspector**, pilih baris lalu Ctrl+C (tersalin sebagai TSV), virtual scroll untuk hasil besar.
- **Export** semua data atau baris terpilih ke CSV, TSV, JSON, JSON (pretty), Markdown, HTML atau Excel (.xlsx), atau salin ke clipboard.
- **Pin results** supaya hasil tetap di tab sendiri, berdampingan.
- **Edit cell**: perubahan menghasilkan script UPDATE berdasarkan primary key di tab baru. Script tidak pernah dijalankan otomatis.
- **Execution plan**: plan grafis dengan bar cost untuk SQL Server; output `EXPLAIN` sebagai grid untuk database lain.
- **Dukungan editor**: autocomplete (database, schema, table, kolom termasuk alias, keyword dan function), formatter (dialect mengikuti koneksi), lint untuk statement tanpa `;` dengan Quick Fix.
- **View samping**: **SQL Files** (folder atau daftar rata), **Running Queries**, **Query History**.

## Instalasi

Dari source:

```bash
npm install
npm run install:local   # build VSIX lalu install bila versinya berubah (tambah -- --force untuk install ulang)
```

Lalu jalankan **Developer: Reload Window**.

Atau build paketnya dan install manual:

```bash
npm run package
code --install-extension moonage-daydream-<version>.vsix
```

## Cara pakai

### 1. Tambah koneksi

Buka view **Moonage Daydream** di Activity Bar lalu klik **+** (**Add Connection**) di view **Connections**. Pilih **Database type**, lalu isi nama, host, port, username, password dan (opsional) database default. **Test** mengecek koneksi sebelum disimpan.

![Form koneksi untuk koneksi PostgreSQL](images/screenshots/connection.png)

Untuk SQL Server form juga punya Windows authentication (domain), instance name dan *trust server certificate*. Untuk MongoDB host boleh berupa connection string lengkap `mongodb://` atau `mongodb+srv://`. Untuk SQLite, isi path file database.

Expand koneksi untuk melihat database, table, view, procedure dan kolom. Pakai ikon play pada table atau view untuk **Select Top 100**, atau ikon file baru pada database untuk **New SQL File** yang langsung terikat ke database itu.

### 2. Menjalankan query

Buka atau buat file `.sql`. CodeLens di atas file menampilkan koneksi dan database file itu; klik untuk mengganti. Lalu:

- **Ctrl+Alt+Enter** menjalankan selection, atau statement di posisi kursor. **Ctrl+Enter** melakukan hal yang sama bila extension DBCode tidak terpasang.
- Setiap statement punya lens **Execute**, **Explain** dan (untuk SELECT) **Analyze**.
- Saat query berjalan, muncul lens **Cancel**; query di-cancel di server.

```sql
SELECT order_id, customer, city, status, total
FROM sales.orders
WHERE status = 'paid';
```

Satu SELECT tanpa limit sendiri hanya mengambil `moonageDaydream.query.autoLimit` baris pertama (default 100). **Load more (+1000)** mengambil halaman berikutnya, sampai 50.000 baris di grid.

Pilih beberapa statement SELECT lalu jalankan bersamaan: semuanya berjalan paralel dan tiap hasil muncul begitu selesai.

![Dua query berjalan paralel, satu selesai dan satu masih berjalan](images/screenshots/parallel.png)

### 3. Filter dan sort

Ketik kondisi di kotak **WHERE** lalu tekan Enter: query dijalankan ulang di server dengan kondisi itu. Ikon filter di header kolom memfilter baris yang sudah dimuat berdasarkan teks; menu kolom untuk sort atau hide kolom. Urutan kolom dan tampil / sembunyi kolom diatur dengan drag dan centang di panel samping **Columns**.

![WHERE status = 'paid' ditambah filter kolom city](images/screenshots/filter.png)

Klik baris untuk memilihnya (Ctrl / Shift untuk lebih dari satu baris); Ctrl+C menyalin pilihan sebagai TSV. Panel samping **Inspector** menampilkan semua kolom dari baris terpilih beserta tipenya; **Columns** menampilkan daftar kolom beserta tipenya.

![Panel samping Inspector menampilkan satu baris dengan tipe kolom](images/screenshots/inspector.png)

### 4. Export

Klik **Export**, pilih **All Data** atau selection dan format (Excel .xlsx, CSV, TSV, JSON, JSON pretty, Markdown, HTML), lalu **Save** ke file atau **Copy** ke clipboard.

![Popup Export dengan All Data dan Excel (.xlsx)](images/screenshots/export.png)

**Pin** menyimpan hasil saat ini di tab sendiri supaya tidak tertimpa query berikutnya.

### 5. Edit cell

Double-click cell di hasil pertama untuk mengeditnya. Jumlah cell yang diubah tampil di footer; **Generate UPDATE script** membuka script UPDATE berdasarkan primary key di tab baru, **Discard** membuang perubahan. Periksa script-nya lalu jalankan sendiri; script tidak pernah dijalankan otomatis.

### 6. Explain dan Analyze

**Explain** menampilkan estimated plan tanpa menjalankan statement. **Analyze** menjalankan SELECT dan menampilkan actual plan (di SQL Server di dalam transaksi yang di-rollback). Untuk SQL Server plan tampil sebagai tree operator dengan bar cost (**Open XML** membuka plan mentahnya); untuk database lain output `EXPLAIN` tampil sebagai grid.

![Plan Analyze SQL Server dengan estimated dan actual rows serta bar cost](images/screenshots/plan.png)

### 7. Transaksi

Default-nya setiap statement auto-commit. Ganti file ke mode manual dengan **Toggle Transaction Mode** (atau CodeLens / status bar): statement lalu berjalan di transaksi yang terbuka sampai Anda klik **Commit** atau **Rollback**. Default untuk file baru diatur lewat `moonageDaydream.transaction.mode`.

### 8. Formatter dan lint

**Format SQL** (Ctrl+Alt+F, atau Format Document) memakai dialect SQL dari koneksi file tersebut. Huruf keyword, koma di depan dan titik koma di baris sendiri bisa diatur. Statement tanpa `;` penutup ditandai, dengan Quick Fix untuk menambahkannya.

### 9. View

- **SQL Files**: semua file `.sql` di workspace, sebagai folder atau daftar rata, dengan **New SQL File**.
- **Running Queries**: query yang sedang berjalan beserta lama berjalannya, cancel satu atau semua.
- **Query History**: jalankan lagi, salin SQL, buka di editor, hapus, kosongkan.

**Move Results To…** (judul view Results) memindahkan hasil ke panel bawah, atau ke kanan atau kiri editor.

Error ditulis ke output channel **Moonage Daydream** (**View → Output**).

## Settings

| Setting | Default | Keterangan |
| --- | --- | --- |
| `moonageDaydream.query.autoLimit` | `100` | Auto limit untuk satu SELECT tanpa TOP / OFFSET FETCH / INTO. `0` = mati |
| `moonageDaydream.transaction.mode` | `auto` | Mode transaksi default untuk file SQL: `auto` atau `manual` |
| `moonageDaydream.format.keywordCase` | `upper` | Huruf keyword saat format: `upper`, `lower`, `preserve` |
| `moonageDaydream.format.leadingComma` | `true` | Koma di awal baris (`    , column`) |
| `moonageDaydream.format.semicolonNewline` | `true` | Titik koma penutup statement di baris sendiri |
| `moonageDaydream.lint.semicolon` | `error` | Tandai statement tanpa `;`: `error`, `warning`, `off` |

Extension ini juga menjadikan dirinya formatter default untuk `[sql]`.

## Keybinding

| Tombol | Command |
| --- | --- |
| Ctrl+Alt+Enter (Cmd+Alt+Enter) | Run Query (selection atau statement di posisi kursor) |
| Ctrl+Enter (Cmd+Enter) | Run Query, hanya bila extension DBCode tidak terpasang |
| Ctrl+Alt+F (Cmd+Alt+F) | Format SQL |
| Shift+Alt+F | Format SQL, bila Moonage Daydream adalah formatter SQL |

## Command

| Command | Keterangan |
| --- | --- |
| `Moonage Daydream: Add Connection` / `Edit Connection` / `Remove Connection` | Kelola koneksi |
| `Moonage Daydream: Select Connection` | Pilih koneksi aktif |
| `Moonage Daydream: Change Connection for This File` / `Change Database for This File` | Koneksi dan database per file |
| `Moonage Daydream: Run Query (selection or whole file)` | Jalankan selection atau statement di posisi kursor |
| `Moonage Daydream: Explain (estimated plan)` / `Analyze (actual plan, SELECT only)` | Execution plan |
| `Moonage Daydream: Cancel Query` / `Cancel All Running Queries` | Cancel di server |
| `Moonage Daydream: Toggle Transaction Mode (Auto-commit / Manual)` | Ganti mode transaksi file |
| `Moonage Daydream: Commit Transaction` / `Rollback Transaction` | Akhiri transaksi manual |
| `Moonage Daydream: Pin Results (keep in its own tab, side by side)` | Pin hasil saat ini |
| `Moonage Daydream: Move Results To…` | Panel, kanan atau kiri editor |
| `Moonage Daydream: Format SQL (Moonage)` | Format dokumen atau selection |
| `Moonage Daydream: New SQL File` | Buat file `.sql` |
| `Moonage Daydream: Clear History` | Kosongkan query history |

## Batasan

- SQLite: seluruh file database dibaca setiap query, dan query yang sedang berjalan tidak bisa di-cancel.
- MongoDB: tidak ada transaksi manual dan tidak ada formatter.
- Grid menampung maksimal 50.000 baris (Load more berhenti di situ); pakai Export untuk semua data.
- SQLite tidak punya Analyze (hanya `EXPLAIN QUERY PLAN`).

## Development

```bash
npm install
npm run compile          # TypeScript -> out/
npm test                 # compile + unit test (node --test)
npm run test:servers     # integration test ke MySQL 8.4, MariaDB 11.4, PostgreSQL 16, MongoDB 7 di Docker
npm run test:real        # Extension Development Host ke koneksi SQL Server yang sudah ada (hanya SELECT)
npm run package          # build .vsix (vsce)
npm run install:local    # build + install ke VS Code lokal (tambah -- --force untuk install ulang versi yang sama)
node scripts/screenshots.js   # buat ulang gambar README (setelah npm run compile)
```

`npm run test:servers` butuh Docker. Script ini menjalankan container, menjalankan `src/test/servers.itest.ts`, lalu menghapus container dan image; set `KEEP_IMAGES=1` untuk menyimpan image untuk run berikutnya.

## Lisensi

MIT, lihat [LICENSE](LICENSE).
