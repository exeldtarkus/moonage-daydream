import { drivers } from './db';
import type { ConnectionInfo, DbType } from './db';
import { driverLog } from './log';

/** isi form dari connection string; field yang tidak ada di string tidak diisi */
export interface ParsedConnection {
  type: DbType;
  host: string;
  port: string;
  instance?: string;
  user?: string;
  password?: string;
  database?: string;
  auth?: 'windows';
  authSource?: string;
  ssl?: boolean;
  trust?: boolean;
  /** opsi lain (query URL) -> Driver settings */
  options?: Record<string, string>;
}

const URL_TYPES: Record<string, DbType> = { mysql: 'mysql', mariadb: 'mariadb', postgres: 'postgres', postgresql: 'postgres', mongodb: 'mongodb', 'mongodb+srv': 'mongodb' };
const truthy = (v: string) => /^(true|yes|1|sspi|mandatory|strict|require|verify-ca|verify-full)$/i.test(v.trim());
const UNSUPPORTED = 'Unsupported connection string (expected Server=...;Database=...; for SQL Server, or a mysql:// mariadb:// postgres:// mongodb:// URL)';

/** SQL Server ADO.NET (Server=..;Database=..) atau URL mysql / mariadb / postgres(ql) / mongodb(+srv) */
export function parseConnectionString(text: string): ParsedConnection {
  const s = text.trim();
  if (!s) throw new Error('Paste a connection string');
  const scheme = /^([a-z+]+):\/\//i.exec(s)?.[1].toLowerCase();
  if (scheme) {
    if (!(scheme in URL_TYPES)) throw new Error(UNSUPPORTED);
    return fromUrl(s, scheme);
  }
  if (/(^|;)\s*(server|data source|address|addr|network address)\s*=/i.test(s)) return fromAdo(s);
  throw new Error(UNSUPPORTED);
}

// shortcut: satu host saja; mongodb://h1,h2/ (replica set beberapa host) belum didukung URL parser, pakai mongodb+srv atau satu host
function fromUrl(s: string, scheme: string): ParsedConnection {
  const type = URL_TYPES[scheme];
  let u: URL;
  try {
    u = new URL(s);
  } catch (e) {
    // input user yang salah: pesan singkat ke form, detail tetap di log
    driverLog.error(`parseConnectionString - EXCEPTION CAUGHT | ${e instanceof Error ? e.message : e} - stack-trace: ${e instanceof Error ? e.stack : e}`);
    throw new Error(`Invalid ${scheme}:// URL`);
  }
  const out: ParsedConnection = {
    type,
    host: scheme === 'mongodb+srv' ? `mongodb+srv://${u.hostname}` : u.hostname,
    port: u.port || String(drivers[type].defaultPort),
  };
  if (u.username) out.user = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (db) out.database = db;
  const options: Record<string, string> = {};
  for (const [k, v] of u.searchParams) {
    if (/^(ssl|tls|sslmode)$/i.test(k)) out.ssl = truthy(v);
    else if (type === 'mongodb' && k === 'authSource') out.authSource = v;
    else options[k] = v;
  }
  if (Object.keys(options).length) out.options = options;
  return out;
}

/** key=value;... ; nilai boleh dikutip '..' / ".." (berisi ;) */
function fromAdo(s: string): ParsedConnection {
  const kv = new Map<string, string>();
  for (const m of s.matchAll(/\s*([^=;]+?)\s*=\s*('(?:[^']|'')*'|"(?:[^"]|"")*"|[^;]*)\s*(?:;|$)/g)) {
    const v = m[2];
    kv.set(m[1].toLowerCase(), /^['"]/.test(v) ? v.slice(1, -1).replace(v[0] === "'" ? /''/g : /""/g, v[0]) : v.trim());
  }
  const pick = (...keys: string[]) => keys.map((k) => kv.get(k)).find((v) => v !== undefined && v !== '');
  const server = pick('server', 'data source', 'address', 'addr', 'network address')!.replace(/^tcp:/i, '');
  const [hostInst, port] = server.split(',');
  const [host, instance] = hostInst.split('\\');
  const out: ParsedConnection = { type: 'mssql', host: host.trim(), port: port?.trim() || String(drivers.mssql.defaultPort) };
  if (instance) out.instance = instance.trim();
  const user = pick('user id', 'uid', 'user', 'username');
  const password = pick('password', 'pwd');
  const database = pick('initial catalog', 'database');
  if (user) out.user = user;
  if (password) out.password = password;
  if (database) out.database = database;
  const integrated = pick('integrated security', 'trusted_connection');
  if (integrated && truthy(integrated)) out.auth = 'windows';
  const encrypt = pick('encrypt');
  if (encrypt !== undefined) out.ssl = truthy(encrypt);
  const trust = pick('trustservercertificate', 'trust server certificate');
  if (trust !== undefined) out.trust = truthy(trust);
  return out;
}

const DBCODE_TYPES: Record<string, DbType> = { mssql: 'mssql', mysql: 'mysql', mariadb: 'mariadb', postgres: 'postgres', sqlite: 'sqlite', mongodb: 'mongodb' };

/**
 * koneksi DBCode (setting `dbcode.connections`) -> koneksi Moonage. Password tidak pernah ikut (DBCode menyimpannya di
 * SecretStorage miliknya sendiri): diisi saat pertama connect. Nama yang sudah dipakai / tipe yang tidak didukung dilewati.
 */
export function importDbcode(list: unknown[], existing: Set<string>): { conns: ConnectionInfo[]; skipped: string[] } {
  const conns: ConnectionInfo[] = [];
  const skipped: string[] = [];
  const taken = new Set(existing);
  for (const raw of list) {
    const e = raw as Record<string, unknown>;
    if (!e || typeof e !== 'object' || typeof e.name !== 'string' || !e.name.trim()) {
      skipped.push('(invalid entry)');
      continue;
    }
    const name = e.name.trim();
    const type = DBCODE_TYPES[String(e.driver)];
    if (!type) {
      skipped.push(`${name} (${e.driver} not supported)`);
      continue;
    }
    if (taken.has(name)) {
      skipped.push(`${name} (name already used)`);
      continue;
    }
    taken.add(name);
    const o = (e.driverOptions ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const host = str(e.host);
    const c: ConnectionInfo = {
      name, type,
      host: type === 'mongodb' && str(o.protocol) === 'mongodb+srv://' ? `mongodb+srv://${host}` : host,
      port: Number(e.port) || drivers[type].defaultPort,
      ...(type === 'mssql' && str(o.instance) ? { instance: str(o.instance) } : {}),
      user: str(e.username), database: str(e.database),
      // DBCode SQL Server: encrypt mengikuti ssl, sertifikat server tidak diperiksa
      trustServerCertificate: type === 'mssql',
      ...(type === 'mssql' && (e.authMethod === 'windows' || /^(windows|ntlm)$/i.test(str(o.authType))) ? { auth: 'windows' as const, domain: str(o.domain) } : {}),
      ...(type === 'sqlite' && str(e.file ?? e.database) ? { file: str(e.file ?? e.database) } : {}),
      ...(typeof e.ssl === 'boolean' ? { ssl: e.ssl } : {}),
      ...(Number(e.connectionTimeout) > 0 ? { connectTimeout: Number(e.connectionTimeout) } : {}),
      ...(e.readOnly === true ? { readOnly: true } : {}),
      ...(str(e.group) ? { group: str(e.group) } : {}),
    };
    conns.push(c);
  }
  return { conns, skipped };
}
