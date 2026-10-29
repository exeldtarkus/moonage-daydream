/** warna koneksi (tanpa vscode: dipakai form + unit test) -> id warna tema VS Code */
export const CONN_COLORS = {
  red: 'charts.red',
  orange: 'charts.orange',
  yellow: 'charts.yellow',
  green: 'charts.green',
  blue: 'charts.blue',
  purple: 'charts.purple',
} as const;
export type ConnColor = keyof typeof CONN_COLORS;

export const isConnColor = (v: unknown): v is ConnColor => typeof v === 'string' && v in CONN_COLORS;

/** teks info koneksi di editor */
export const bannerText = (c: { name: string; group?: string }) => `you are using connection ${c.group ? `${c.group} - ` : ''}${c.name}`;
