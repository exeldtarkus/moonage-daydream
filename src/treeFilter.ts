// filter di view Connections (per node) + pemuat objek untuk Find Object; tanpa vscode supaya bisa di-unit test
import type { Node } from './explorer';
import { MS_DB, MS_SERVER, MS_TREE } from './mssqlTree';

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
 * induk node untuk TreeView.reveal (Find Object -> sorot objek di Connections): objek -> folder -> database -> koneksi -> group.
 * SQL Server lewat folder Object Explorer (Databases, Tables, Views, Programmability > Stored Procedures).
 */
export function treeParent(n: Node): Node | undefined {
  switch (n.kind) {
    case 'conn': return n.c.group ? { kind: 'group', group: n.c.group } : undefined;
    case 'db': return n.c.type === 'mssql' ? { kind: 'mfolder', c: n.c, folder: 'databases' } : { kind: 'conn', c: n.c };
    case 'folder': return { kind: 'db', c: n.c, db: n.db };
    case 'obj': {
      if (n.c.type !== 'mssql') return n.objKind === 'table' || n.objKind === 'view' || n.objKind === 'procedure' ? { kind: 'folder', c: n.c, db: n.db, objKind: n.objKind } : undefined;
      const folder = n.objKind === 'table' ? 'tables' : n.objKind === 'view' ? 'views' : n.objKind === 'procedure' ? 'procedures' : undefined;
      return folder ? { kind: 'mfolder', c: n.c, folder, db: n.db } : undefined;
    }
    case 'mfolder': {
      if (n.obj) return undefined; // folder di bawah tabel / view (Columns, Keys, ...): tidak dipakai reveal
      if (MS_SERVER.includes(n.folder)) return { kind: 'conn', c: n.c };
      if (n.db !== undefined && MS_DB.includes(n.folder)) return { kind: 'db', c: n.c, db: n.db };
      const up = Object.keys(MS_TREE).find((k) => MS_TREE[k].folders?.includes(n.folder));
      return up ? { kind: 'mfolder', c: n.c, folder: up, db: n.db } : undefined;
    }
    default: return undefined;
  }
}

/** teks baris koneksi di Connections: label = - [ nama ] (satu warna = warna koneksi), detail di deskripsi setelah " - " */
export function connText(name: string, type: string, addr: string, o: { active?: boolean; noConfirm?: boolean }): { label: string; description: string } {
  return {
    label: `- [ ${name} ]`,
    description: `- ${type} · ${addr}${o.active ? ' · active' : ''}${o.noConfirm ? ' · no commit confirm' : ''}`,
  };
}

/** koneksi yang baru terhubung / terputus sejak snapshot sebelumnya (nama koneksi) */
export function connStateChange(before: string[], now: string[]): { connected: string[]; disconnected: string[] } {
  return { connected: now.filter((x) => !before.includes(x)), disconnected: before.filter((x) => !now.includes(x)) };
}
