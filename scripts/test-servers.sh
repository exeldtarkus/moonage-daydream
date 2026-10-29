#!/usr/bin/env bash
# Test driver MySQL / MariaDB / PostgreSQL / MongoDB ke server sungguhan di Docker (database "shop" sementara).
# run: npm run test:servers   -> container + image dihapus lagi setelah selesai (KEEP_IMAGES=1 = image disimpan untuk run berikutnya)
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
PW=moonage-test # password container test lokal sekali pakai (bukan kredensial sungguhan)
MYSQL=mysql:8.4 MARIADB=mariadb:11.4 POSTGRES=postgres:16-alpine MONGO=mongo:7
NAMES=(moonage-mysql moonage-mariadb moonage-postgres moonage-mongo)

cleanup() {
  docker rm -f "${NAMES[@]}" >/dev/null 2>&1
  [ "${KEEP_IMAGES:-0}" = 1 ] || docker rmi "$MYSQL" "$MARIADB" "$POSTGRES" "$MONGO" >/dev/null 2>&1
  echo "[servers] cleanup: containers removed, images $([ "${KEEP_IMAGES:-0}" = 1 ] && echo kept || echo removed)"
}
trap cleanup EXIT

docker rm -f "${NAMES[@]}" >/dev/null 2>&1
docker run -d --name moonage-mysql -e MYSQL_ROOT_PASSWORD=$PW -e MYSQL_DATABASE=shop -p 127.0.0.1:13306:3306 "$MYSQL" >/dev/null || exit 1
docker run -d --name moonage-mariadb -e MARIADB_ROOT_PASSWORD=$PW -e MARIADB_DATABASE=shop -p 127.0.0.1:13307:3306 "$MARIADB" >/dev/null || exit 1
docker run -d --name moonage-postgres -e POSTGRES_PASSWORD=$PW -e POSTGRES_DB=shop -p 127.0.0.1:15432:5432 "$POSTGRES" >/dev/null || exit 1
docker run -d --name moonage-mongo -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=$PW -p 127.0.0.1:27018:27017 "$MONGO" >/dev/null || exit 1

# siap = menerima koneksi TCP (server init sementara di image resmi hanya lewat socket)
ready() {
  docker exec moonage-mysql mysql -h127.0.0.1 --protocol=tcp -uroot -p$PW -e 'SELECT 1' >/dev/null 2>&1 &&
  docker exec moonage-mariadb mariadb -h127.0.0.1 --protocol=tcp -uroot -p$PW -e 'SELECT 1' >/dev/null 2>&1 &&
  docker exec moonage-postgres pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 &&
  docker exec moonage-mongo mongosh --quiet -u root -p $PW --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1
}
for _ in $(seq 1 90); do ready && break; sleep 2; done
ready || { echo "[servers] servers not ready after 180 s"; docker ps -a; exit 1; }
echo "[servers] ready"

cd "$root" && MOONAGE_TEST_PW=$PW node --test out/test/servers.itest.js
