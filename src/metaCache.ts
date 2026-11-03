// cache metadata (database, tabel, view, procedure) per koneksi untuk Find Object; tanpa vscode supaya bisa di-unit test
import { promises as fs } from 'fs';
import { join } from 'path';
import type { DbObject, ListKind } from './db';

export type MetaKind = 'db' | ListKind;
/** satu record Find Object: database (kind 'db', name = db) atau objek di database itu */
export interface MetaRecord { conn: string; db: string; kind: MetaKind; schema: string; name: string }
/** isi satu chunk: satu file per koneksi + database */
interface Chunk { db: string; updated: string; objects: [ListKind, string, string][] }

const KINDS: ListKind[] = ['table', 'view', 'procedure'];
const connDir = (dir: string, conn: string) => join(dir, encodeURIComponent(conn));
const chunkFile = (dir: string, conn: string, db: string) => join(connDir(dir, conn), `${encodeURIComponent(db)}.json`);

/** tulis lewat file sementara + rename: pembaca tidak pernah melihat chunk setengah jadi; izin 0600 (nama objek bisa sensitif) */
async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * baca ulang metadata satu koneksi: tiap database ditulis sebagai chunk sendiri begitu selesai (paralel maksimal `limit`),
 * database yang gagal dibaca dilaporkan lewat onError dan chunk lamanya dipertahankan, database yang sudah tidak ada dihapus.
 */
export async function refreshMeta(dir: string, conn: string, src: { databases(): Promise<string[]>; objects(db: string, kind: ListKind): Promise<DbObject[]> },
  onError: (db: string, e: unknown) => void, limit = 4): Promise<void> {
  const dbs = await src.databases();
  await fs.mkdir(connDir(dir, conn), { recursive: true, mode: 0o700 });
  const queue = [...dbs];
  const worker = async () => {
    for (let db = queue.shift(); db !== undefined; db = queue.shift()) {
      try {
        const lists = await Promise.all(KINDS.map(async (k) => (await src.objects(db!, k)).map((o): [ListKind, string, string] => [k, o.schema, o.name])));
        const chunk: Chunk = { db, updated: new Date().toISOString(), objects: lists.flat() };
        await writeAtomic(chunkFile(dir, conn, db), JSON.stringify(chunk));
      } catch (e) {
        onError(db, e); // pemanggil yang mencatat log ERROR (modul ini tanpa logger)
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  const keep = new Set(dbs.map((db) => `${encodeURIComponent(db)}.json`));
  for (const f of await fs.readdir(connDir(dir, conn))) if (!keep.has(f)) await fs.rm(join(connDir(dir, conn), f), { force: true });
}

/** semua record di cache (atau satu koneksi); folder / chunk rusak dilewati */
export async function readMeta(dir: string, onlyConn?: string): Promise<MetaRecord[]> {
  const conns = onlyConn !== undefined ? [encodeURIComponent(onlyConn)] : await fs.readdir(dir).catch(() => [] as string[]); // folder belum ada = cache kosong
  const out: MetaRecord[] = [];
  for (const c of conns) {
    const conn = decodeURIComponent(c);
    const files = await fs.readdir(join(dir, c)).catch(() => [] as string[]); // koneksi belum pernah di-cache
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      let chunk: Chunk;
      try {
        chunk = JSON.parse(await fs.readFile(join(dir, c, f), 'utf8')) as Chunk;
      } catch {
        continue; // chunk rusak / sedang dihapus: dilewati, dibuat ulang pada refresh berikutnya
      }
      out.push({ conn, db: chunk.db, kind: 'db', schema: '', name: chunk.db });
      for (const [kind, schema, name] of chunk.objects) out.push({ conn, db: chunk.db, kind, schema, name });
    }
  }
  return out;
}

/** hapus cache satu koneksi (koneksi dihapus / di-rename) */
export const removeMeta = (dir: string, conn: string) => fs.rm(connDir(dir, conn), { recursive: true, force: true });

/** buang cache koneksi yang sudah tidak ada (sisa koneksi yang dihapus saat refresh masih berjalan / sebelum fitur ini) */
export async function pruneMeta(dir: string, names: string[]): Promise<void> {
  const keep = new Set(names.map(encodeURIComponent));
  const dirs = await fs.readdir(dir).catch(() => [] as string[]); // folder belum ada = tidak ada yang dibuang
  for (const d of dirs) if (!keep.has(d)) await fs.rm(join(dir, d), { recursive: true, force: true });
}
