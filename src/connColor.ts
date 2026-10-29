/** warna koneksi (tanpa vscode: dipakai form + unit test) -> id warna tema VS Code (charts.* / terminal.ansi*: ikut tema terang / gelap) */
export const CONN_COLORS = {
  red: 'charts.red',
  coral: 'terminal.ansiBrightRed',
  orange: 'charts.orange',
  yellow: 'charts.yellow',
  gold: 'terminal.ansiBrightYellow',
  lime: 'terminal.ansiBrightGreen',
  green: 'charts.green',
  teal: 'terminal.ansiCyan',
  cyan: 'terminal.ansiBrightCyan',
  sky: 'terminal.ansiBrightBlue',
  blue: 'charts.blue',
  purple: 'charts.purple',
  magenta: 'terminal.ansiMagenta',
  pink: 'terminal.ansiBrightMagenta',
  gray: 'terminal.ansiBrightBlack',
} as const;
export type ConnColor = keyof typeof CONN_COLORS;

export const isConnColor = (v: unknown): v is ConnColor => typeof v === 'string' && v in CONN_COLORS;

/** variabel CSS warna tema di webview: charts.red -> var(--vscode-charts-red) */
export const cssColor = (c: ConnColor) => `var(--vscode-${CONN_COLORS[c].replace('.', '-')})`;

/** Red, Coral, ... */
export const colorLabel = (c: ConnColor) => c[0].toUpperCase() + c.slice(1);

/** teks info koneksi di editor */
export const bannerText = (c: { name: string; group?: string }) => `you are using connection ${c.group ? `${c.group} - ` : ''}${c.name}`;
