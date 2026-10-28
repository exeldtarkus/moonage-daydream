#!/usr/bin/env bash
# Buka Extension Development Host (setara F5) dengan extension dari folder ini, tanpa install.
# run: npm run dev
# Tanpa argumen membuka test-extention/ (contoh .sql untuk test) (kalau tidak, VS Code membuka ulang folder terakhir); `npm run dev -- <folder>` untuk folder lain.
# Di WSL, `code` remote-cli tidak mendukung --extensionDevelopmentPath, jadi pakai `code` Windows (path Linux diubah otomatis oleh ekstensi Remote WSL).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
folder="$(realpath "${1:-$root/test-extention}")"
if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  wincode="$(ls -d /mnt/c/Users/*/AppData/Local/Programs/"Microsoft VS Code"/bin/code 2>/dev/null | head -1)"
  [[ -n "$wincode" ]] || { echo "[dev] VS Code Windows tidak ditemukan di /mnt/c/Users/*/AppData/Local/Programs" >&2; exit 1; }
  "$wincode" --extensionDevelopmentPath="$root" "$folder"
  # jendela dev yang sudah terbuka hanya di-reload dengan workspace lamanya: minta extension pindah ke $folder
  sleep "${OPEN_WAIT:-8}"
  powershell.exe -NoProfile -Command "Start-Process 'vscode://exeltarkus.moonage-daydream/open-folder?folder=$folder'"
  exit 0
fi
exec code --extensionDevelopmentPath="$root" "$folder"
