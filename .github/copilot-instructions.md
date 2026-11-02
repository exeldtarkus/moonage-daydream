# Moonage Daydream — instruksi Copilot

Aturan lengkap project ada di `CLAUDE.md` di root repo (bisa jadi hanya ada lokal).

## Linter

- Setiap selesai mengubah kode jalankan `npm run lint` dan `npm test`; keduanya wajib bersih (0 error) sebelum commit.
- Perbaiki temuannya, bukan mematikan rule; `// eslint-disable-next-line <rule> -- <alasan>` hanya per baris bila memang
  disengaja (contoh yang ada: lazy `require('./test/real')`, throw di `finally`).
- Sebelum `git push` WAJIB jalankan `npm run lint` dulu dan pastikan 0 error; hook `.githooks/pre-push` (aktif lewat
  `npm install` -> script `prepare` -> `core.hooksPath`) membatalkan push bila lint gagal; jangan melewati hook dengan
  `--no-verify`.
- Jangan menambah rule / plugin baru tanpa diminta user.
- Config: `eslint.config.mjs` (typescript-eslint recommended); `npm run lint:fix` memperbaiki otomatis yang bisa.
  CI (`.github/workflows/release.yml`) menjalankan `npm run lint` sebelum `npm test`.

## Konvensi terkait

- Jangan `console.log` / `console.error` (rule `no-console`): pakai `log` (`LogOutputChannel`, modul ber-`vscode`) atau
  `driverLog` dari `./log` (modul driver).
- Setiap `catch` wajib log level ERROR dengan pesan + stack:
  `<konteks> - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`. Catch kosong dilarang (`no-empty`);
  catch yang sengaja diabaikan tetap di-log dan diberi komentar alasannya.
- Variabel yang sengaja tidak dipakai diberi prefix `_`.
- Komentar kode berbahasa Indonesia.
- TDD: tulis unit test dulu di `src/test/*.test.ts`, pastikan gagal, baru implementasi sampai lulus.
