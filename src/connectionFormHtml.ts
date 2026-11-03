import { randomBytes } from 'crypto';
import { drivers } from './db';
import type { ConnectionInfo, DbType } from './db';
import { CONN_COLORS, colorLabel, cssColor, isConnColor } from './connColor';
import type { ConnColor } from './connColor';
import { esc } from './resultsHtml';
import { pageJson, webviewPage } from './webviewPage';

export interface FormData {
  /** default mssql */
  type?: string;
  /** sqlite: path file database */
  file?: string;
  /** mongodb: database tempat user dibuat */
  authSource?: string;
  /** folder di view Connections */
  group?: string;
  /** red / orange / ... ; kosong = tanpa warna */
  color?: string;
  name: string;
  host: string;
  port: string;
  instance: string;
  user: string;
  password: string;
  database: string;
  trust: boolean;
  /** 'sql' (default) | 'windows' (NTLM) */
  auth?: string;
  domain?: string;
  /** SSL / TLS (mssql: encrypt) */
  ssl?: boolean;
  /** detik; kosong = default driver */
  connectTimeout?: string;
  /** Permissions: hanya statement yang tidak mengubah data */
  readOnly?: boolean;
  /** Driver settings: baris [nama, nilai]; baris kosong diabaikan */
  options?: [string, string][];
}

/** baris Driver settings yang terisi, nama di-trim */
const optionRows = (d: FormData) => (d.options ?? []).map(([k, v]) => [k.trim(), v] as [string, string]).filter(([k, v]) => k || v.trim());

/** validasi form; return pesan error atau undefined */
export function validate(d: FormData, conns: { get(name: string): unknown }, oldName?: string): string | undefined {
  if (!d.name.trim()) return 'Connection name is required';
  if (d.name.trim() !== oldName && conns.get(d.name.trim())) return `Connection name "${d.name.trim()}" is already used`;
  if (d.group !== undefined && /^\s+$/.test(d.group)) return 'Group name is required';
  if (d.color && !isConnColor(d.color)) return `Unknown color ${d.color}`;
  if (d.type && !(d.type in drivers)) return `Unknown database type ${d.type}`;
  const timeout = d.connectTimeout?.trim();
  if (timeout && !(/^\d+$/.test(timeout) && +timeout >= 1 && +timeout <= 3600)) return 'Connection timeout must be 1-3600 seconds';
  const seen = new Set<string>();
  for (const [k] of optionRows(d)) {
    if (!k) return 'Driver setting name is required';
    if (seen.has(k)) return `Driver setting "${k}" is set twice`;
    seen.add(k);
  }
  if (d.type === 'sqlite') return d.file?.trim() ? undefined : 'Database file is required';
  if (!d.host.trim()) return 'Host is required';
  if (!/^\d+$/.test(d.port) || +d.port < 1 || +d.port > 65535) return 'Port must be 1-65535';
  if (d.auth === 'windows' && !d.domain?.trim()) return 'Domain is required for Windows authentication';
  if (d.auth === 'windows' && !d.user.trim()) return 'Username is required for Windows authentication';
  return undefined;
}

export function toConnection(d: FormData): ConnectionInfo {
  const group = d.group?.trim();
  const c = connectionOf(d);
  const net = c.type !== 'sqlite';
  const opts = optionRows(d);
  return {
    ...c, ...(group ? { group } : {}), ...(isConnColor(d.color) ? { color: d.color } : {}),
    ...(net && typeof d.ssl === 'boolean' ? { ssl: d.ssl } : {}),
    ...(net && d.connectTimeout?.trim() ? { connectTimeout: +d.connectTimeout.trim() } : {}),
    ...(d.readOnly ? { readOnly: true } : {}),
    ...(net && opts.length ? { options: Object.fromEntries(opts) } : {}),
  };
}

function connectionOf(d: FormData): ConnectionInfo {
  const type = (d.type || 'mssql') as DbType;
  if (type === 'sqlite') return { name: d.name.trim(), type, host: '', port: 0, user: '', database: '', trustServerCertificate: false, file: d.file!.trim() };
  // Consul: datacenter di field database, ACL token di password; tanpa user
  if (type === 'consul') return { name: d.name.trim(), type, host: d.host.trim(), port: +d.port, user: '', database: d.database.trim(), trustServerCertificate: !!d.trust };
  if (type !== 'mssql') {
    return {
      name: d.name.trim(), type, host: d.host.trim(), port: +d.port, user: d.user.trim(), database: d.database.trim(), trustServerCertificate: !!d.trust,
      ...(type === 'mongodb' && d.authSource?.trim() ? { authSource: d.authSource.trim() } : {}),
    };
  }
  return {
    name: d.name.trim(), type, host: d.host.trim(), port: +d.port, instance: d.instance.trim() || undefined,
    user: d.user.trim(), database: d.database.trim(), trustServerCertificate: d.trust,
    ...(d.auth === 'windows' ? { auth: 'windows' as const, domain: d.domain?.trim() } : {}),
  };
}

/** deskripsi singkat di kartu pilih database */
const DB_HINT: Record<DbType, string> = {
  mssql: 'Microsoft SQL Server, Azure SQL', mysql: 'MySQL 5.7 / 8.x', mariadb: 'MariaDB 10.x / 11.x',
  postgres: 'PostgreSQL 12+', sqlite: 'Local database file', mongodb: 'MongoDB, Atlas (mongodb+srv)', consul: 'HashiCorp Consul: KV store and service catalog',
};
/** warna brand untuk aksen kartu */
const DB_BRAND: Record<DbType, string> = {
  mssql: '#cc2927', mysql: '#00758f', mariadb: '#c0765a', postgres: '#336791', sqlite: '#0f80cc', mongodb: '#47a248', consul: '#e03875',
};
const EYE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 13.5 13.5 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/** kata lain yang cocok di pencarian database */
const DB_ALIAS: Record<DbType, string> = {
  mssql: 'mssql microsoft azure tsql t-sql', mysql: 'oracle', mariadb: 'maria', postgres: 'pg postgresql psql', sqlite: 'file local lite', mongodb: 'mongo atlas nosql document', consul: 'hashicorp kv key value service catalog',
};

/** username contoh per tipe (diganti saat ganti tipe selama belum diubah user) */
const DEFAULT_USER: Record<DbType, string> = { mssql: 'sa', mysql: 'root', mariadb: 'root', postgres: 'postgres', sqlite: '', mongodb: '', consul: '' };

/**
 * Form koneksi dua langkah: (1) pilih database (kartu + logo), (2) form per bagian untuk tipe itu. Edit langsung ke langkah 2.
 * group: dropdown (tanpa group / group yang ada / New group… -> kolom isian); preset = group folder tempat Add Connection diklik.
 * logos: data URI svg per tipe (media/db), kosong = tanpa gambar.
 */
export function formHtml(cspSource: string, old?: ConnectionInfo, groups: string[] = [], preset?: string, logos: Partial<Record<DbType, string>> = {}): string {
  const group = old?.group ?? preset ?? '';
  const all = group && !groups.includes(group) ? [...groups, group].sort() : groups;
  const nonce = randomBytes(16).toString('base64');
  const v = (s: string | number | undefined) => `value="${esc(String(s ?? ''))}"`;
  const optRow = (k: string, val: string) => `<div class="opt"><input type="text" class="ok" ${v(k)} placeholder="name" aria-label="Setting name">`
    + `<input type="text" class="ov" ${v(val)} placeholder="value" aria-label="Setting value"><button type="button" class="rm" title="Remove setting" aria-label="Remove setting">×</button></div>`;
  const types = Object.entries(drivers) as [DbType, (typeof drivers)[DbType]][];
  const logo = (t: DbType, cls: string) => (logos[t] ? `<img class="${cls}" src="${logos[t]}" alt="">` : `<span class="${cls} nologo">${esc(drivers[t].label[0])}</span>`);
  const swatches = ['', ...Object.keys(CONN_COLORS)].map((c) =>
    `<button type="button" class="sw${(old?.color ?? '') === c ? ' on' : ''}" data-color="${c}" title="${c ? colorLabel(c as ConnColor) : 'None'}" aria-label="${c || 'no'} color"${c ? ` style="--c: ${cssColor(c as ConnColor)}"` : ''}></button>`).join('');
  return webviewPage('connectionForm', {
    cspSource,
    nonce,
    pickHidden: old ? ' hidden' : '',
    dbCards: types.map(([k, d], i) =>
    `<button type="button" class="db" data-type="${k}" data-port="${d.defaultPort}" data-search="${esc(`${d.label} ${DB_HINT[k]} ${k} ${DB_ALIAS[k]}`.toLowerCase())}" style="--brand: ${DB_BRAND[k]}; --i: ${i}">`
    + `<span class="top">${logo(k, 'logo')}<span><b>${esc(d.label)}</b><small>${esc(DB_HINT[k])}</small></span></span>`
    + `<span class="foot"><span>${k === 'sqlite' ? 'Database file' : `Default port ${d.defaultPort}`}</span><span class="go">Connect →</span></span></button>`).join(''),
    formHidden: old ? '' : ' hidden',
    type: esc(old?.type ?? 'mssql'),
    logos: types.map(([k]) => `<span data-logo="${k}" hidden>${logo(k, 'logo-sm')}</span>`).join(''),
    heading: old ? `Edit: ${esc(old.name)}` : 'New connection',
    name: v(old?.name),
    noGroupSelected: group ? '' : ' selected',
    groupOptions: all.map((g) => `<option value="${esc(g)}"${g === group ? ' selected' : ''}>${esc(g)}</option>`).join(''),
    swatches,
    color: v(old?.color),
    file: v(old?.file),
    host: v(old?.host ?? 'localhost'),
    port: v(old?.port ?? 1433),
    instance: v(old?.instance),
    sqlAuthSelected: old?.auth === 'windows' ? '' : ' selected',
    winAuthSelected: old?.auth === 'windows' ? ' selected' : '',
    sqlAuthHidden: old?.auth === 'windows' ? '' : ' hidden',
    domain: v(old?.domain),
    user: v(old?.user ?? DEFAULT_USER[old?.type ?? 'mssql']),
    passwordPlaceholder: old ? 'Leave empty to keep current password' : '',
    eye: EYE,
    authSource: v(old?.authSource),
    database: v(old?.database),
    sslChecked: old?.ssl ?? (old?.type ?? 'mssql') === 'mssql' ? ' checked' : '',
    trustChecked: old?.trustServerCertificate ?? true ? 'checked' : '',
    connectTimeout: v(old?.connectTimeout),
    readOnlyChecked: old?.readOnly ? ' checked' : '',
    optionRows: Object.entries(old?.options ?? {}).map(([k, val]) => optRow(k, val)).join(''),
    data: pageJson({
      labels: Object.fromEntries(types.map(([k, d]) => [k, d.label])),
      defaultUser: DEFAULT_USER,
      editing: !!old,
      optRow: optRow('', ''),
      eye: EYE,
      eyeOff: EYE_OFF,
    }),
  });
}
