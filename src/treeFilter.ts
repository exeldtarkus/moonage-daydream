// filter di view Connections (per node) + pemuat objek untuk Find Object; tanpa vscode supaya bisa di-unit test
import type { DbObject, ListKind } from './db';
import type { Node } from './explorer';

/** teks filter cocok: mengandung, tidak peka huruf besar / kecil; kosong = semua */
export const matchFilter = (name: string, f?: string) => !f?.trim() || name.toLowerCase().includes(f.trim().toLowerCase());

/** kunci filter node yang bisa difilter (koneksi, database, folder objek, folder SQL Server); node lain undefined */
export function filterKey(n: Node): string | undefined {
  switch (n.kind) {
    case 'conn': return n.c.type === 'consul' ? undefined : `conn\0${n.c.name}`;
    case 'db': return `db\0${n.c.name}\0${n.db}`;
    case 'folder': return `folder\0${n.c.name}\0${n.db}\0${n.objKind}`;
    case 'mfolder': return `ms\0${n.c.name}\0${n.db ?? ''}\0${n.folder}\0${n.obj ? `${n.obj.schema}.${n.obj.name}` : n.full ?? ''}`;
    default: return undefined;
  }
}

/** nama yang dicocokkan; undefined = node tidak pernah disembunyikan (folder, pesan) */
function nameOf(n: Node): string | undefined {
  if (n.kind === 'db') return n.db;
  if (n.kind === 'obj') return n.obj.schema ? `${n.obj.schema}.${n.obj.name}` : n.obj.name;
  if (n.kind === 'item' || n.kind === 'col') return n.label;
  return undefined;
}

/**
 * anak node setelah filter: filter folder berlaku ke isi folder itu (bukan subfolder), filter koneksi ke daftar database,
 * filter database ke objek di semua folder di bawahnya; semua filter yang berlaku harus cocok.
 */
export function applyFilters(parent: Node, children: Node[], get: (key: string) => string | undefined): Node[] {
  const own = parent.kind === 'folder' || parent.kind === 'mfolder' ? get(filterKey(parent)!) : undefined;
  return children.filter((x) => {
    const name = nameOf(x);
    if (name === undefined) return true;
    const up = x.kind === 'db' ? get(filterKey({ kind: 'conn', c: x.c })!) : x.kind === 'obj' ? get(filterKey({ kind: 'db', c: x.c, db: x.db })!) : undefined;
    return matchFilter(name, own) && matchFilter(name, up);
  });
}

/**
 * Find Object: objek semua database x jenis, paralel maksimal `limit` sekaligus; hasil dikirim per batch (Quick Pick terisi bertahap),
 * database yang gagal (mis. tanpa izin) dilaporkan lalu dilewati; berhenti begitu cancelled() (Quick Pick ditutup).
 */
export async function loadObjects(dbs: string[], kinds: ListKind[], fetch: (db: string, kind: ListKind) => Promise<DbObject[]>,
  onBatch: (db: string, kind: ListKind, objs: DbObject[]) => void, onError: (db: string, e: unknown) => void, cancelled: () => boolean, limit = 4): Promise<void> {
  const jobs = dbs.flatMap((db) => kinds.map((kind) => [db, kind] as const));
  const worker = async () => {
    for (let job = jobs.shift(); job && !cancelled(); job = jobs.shift()) {
      const [db, kind] = job;
      try {
        onBatch(db, kind, await fetch(db, kind));
      } catch (e) {
        onError(db, e); // pemanggil yang mencatat log ERROR (modul ini tanpa logger)
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}
