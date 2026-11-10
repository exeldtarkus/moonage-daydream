import { driverLog } from './log';

// urutan + pin di view "Open" (disimpan per workspace); tanpa vscode supaya bisa di-unit test

/** urut tampil: yang di-pin di atas, lalu urutan tersimpan; item yang belum punya urutan di belakang sesuai urutan tab */
export function arrangeOpen<T extends { uri: string }>(items: T[], order: string[], pinned: string[]): (T & { pinned: boolean })[] {
  const rank = new Map(order.map((u, i) => [u, i]));
  const pin = new Set(pinned);
  const sorted = items.map((x, i) => ({ x, i })).sort((a, b) =>
    (rank.get(a.x.uri) ?? order.length + a.i) - (rank.get(b.x.uri) ?? order.length + b.i));
  const out = sorted.map(({ x }) => ({ ...x, pinned: pin.has(x.uri) }));
  return [...out.filter((x) => x.pinned), ...out.filter((x) => !x.pinned)];
}

/** urutan baru setelah drag: `moved` diletakkan sebelum `target` (undefined = paling bawah); hanya item yang tampil yang disimpan */
export function moveInOrder(shown: string[], moved: string[], target: string | undefined): string[] {
  if (target !== undefined && moved.includes(target)) return shown;
  const rest = shown.filter((u) => !moved.includes(u));
  const at = target === undefined ? rest.length : rest.indexOf(target);
  rest.splice(at < 0 ? rest.length : at, 0, ...moved.filter((u) => shown.includes(u)));
  return rest;
}

/** file yang di-pin tetap tampil walau tab-nya ditutup (klik = buka lagi); untitled yang sudah ditutup tidak bisa dibuka, jadi dibuang */
export function withClosedPinned<T extends { uri: string; label: string; untitled: boolean; dirty: boolean }>(items: T[], pinned: string[]): T[] {
  const open = new Set(items.map((i) => i.uri));
  const closed = pinned.filter((u) => !open.has(u) && !u.startsWith('untitled:')).map((uri) => {
    let name = uri.slice(uri.lastIndexOf('/') + 1);
    try {
      name = decodeURIComponent(name);
    } catch (e) {
      // nama bukan URI valid: pakai apa adanya
      driverLog.error(`withClosedPinned - EXCEPTION CAUGHT | ${e instanceof Error ? e.message : e} - stack-trace: ${e instanceof Error ? e.stack : e}`);
    }
    return { uri, label: name, untitled: false, dirty: false } as T;
  });
  return [...items, ...closed];
}
