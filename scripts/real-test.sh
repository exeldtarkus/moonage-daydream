#!/usr/bin/env bash
# Test real: buka jendela dev lalu kirim URI yang menjalankan out/test/real (hanya SELECT).
# run: npm run test:real [-- <nama test, mis. big>]   (laporan: ~/.claude/bg-logs/moonage-real-test.log)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
report="$HOME/.claude/bg-logs/moonage-real-test.log"
rm -f "$report"
only="${1:-}"
bash "$root/scripts/dev.sh"
sleep "${WAIT_WINDOW:-12}" # tunggu jendela dev siap (termasuk reload bila dev.sh memindah folder)
# pemicu utama: file yang dipantau jendela dev (URI hanya cadangan, bisa jatuh ke jendela VS Code lain)
mkdir -p "$root/docs/main/temp" && printf '%s' "$only" > "$root/docs/main/temp/real-test.trigger"
for i in $(seq 1 90); do grep -q DONE "$report" 2>/dev/null && break; [ "$i" = 15 ] && [ ! -s "$report" ] && [ -f "$root/docs/main/temp/real-test.trigger" ] && powershell.exe -NoProfile -Command "Start-Process 'vscode://exeltarkus.moonage-daydream/real-test${only:+?$only}'"; sleep 2; done
cat "$report" 2>/dev/null || { echo "[real-test] tidak ada laporan di $report" >&2; exit 1; }
grep -q "DONE failed=0" "$report"
