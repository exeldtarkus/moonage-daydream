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

/** hex (nilai tema Dark+ / terminal default) untuk ikon gutter: gambar SVG tidak bisa memakai warna tema */
export const CONN_HEX: Record<ConnColor, string> = {
  red: '#f14c4c', coral: '#ff7b72', orange: '#d18616', yellow: '#cca700', gold: '#e5c07b', lime: '#23d18b', green: '#89d185',
  teal: '#11a8cd', cyan: '#29b8db', sky: '#3b8eea', blue: '#3794ff', purple: '#b180d7', magenta: '#bc3fbc', pink: '#d670d6', gray: '#8b8b8b',
};

/** garis tipis di gutter (SVG data URI): tidak menempel ke teks query */
export const gutterSvg = (c: ConnColor) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="6" height="20" viewBox="0 0 6 20" preserveAspectRatio="none"><rect x="1" y="0" width="2" height="20" fill="${CONN_HEX[c]}" fill-opacity="0.55"/></svg>`).toString('base64')}`;

export const isConnColor = (v: unknown): v is ConnColor => typeof v === 'string' && v in CONN_COLORS;

/** variabel CSS warna tema di webview: charts.red -> var(--vscode-charts-red) */
export const cssColor = (c: ConnColor) => `var(--vscode-${CONN_COLORS[c].replace('.', '-')})`;

/** Red, Coral, ... */
export const colorLabel = (c: ConnColor) => c[0].toUpperCase() + c.slice(1);

/** teks info koneksi di editor */
export const bannerText = (c: { name: string; group?: string }) => `you are using connection ${c.group ? `${c.group} - ` : ''}${c.name}`;
