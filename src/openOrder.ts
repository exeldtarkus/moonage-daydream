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
