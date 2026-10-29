import { driverLog } from './log';
import type { ConnectionInfo, Driver } from './db';

/** koneksi Consul (HTTP API); token ACL dari SecretStorage */
export interface ConsulTarget { host: string; port: number; ssl?: boolean; datacenter?: string }
/** entri KV mentah dari API (Value base64, null = folder / kosong) */
export interface KvEntry { Key: string; Value: string | null; Flags: number; ModifyIndex?: number; Session?: string }

/** URL API; dc dulu, lalu query (true = parameter tanpa nilai, mis. ?keys) */
export function consulUrl(c: ConsulTarget, path: string, query: Record<string, string | number | true> = {}): string {
  const q = [...(c.datacenter ? [`dc=${encodeURIComponent(c.datacenter)}`] : []),
    ...Object.entries(query).map(([k, v]) => (v === true ? k : `${k}=${encodeURIComponent(String(v))}`))];
  return `${c.ssl ? 'https' : 'http'}://${c.host}:${c.port}${path}${q.length ? `?${q.join('&')}` : ''}`;
}

/** key -> path URL, tiap segmen di-encode (spasi, karakter non-ASCII), / tetap pemisah */
export const kvPath = (key: string) => `/v1/kv/${key.split('/').map(encodeURIComponent).join('/')}`;

/** hasil ?keys&separator=/ satu level: folder (diakhiri /) dan key; prefix sendiri dibuang */
export function kvChildren(keys: string[], prefix: string): { folders: string[]; keys: string[] } {
  const own = keys.filter((k) => k !== prefix);
  return { folders: own.filter((k) => k.endsWith('/')), keys: own.filter((k) => !k.endsWith('/')) };
}

export const decodeKv = (e: { Value: string | null }) => (e.Value ? Buffer.from(e.Value, 'base64').toString('utf8') : '');

/** format value untuk editor / validasi sebelum disimpan */
export function detectFormat(text: string): 'json' | 'yaml' | 'text' {
  const t = text.trim();
  // diawali { / [ tapi bukan JSON valid: dianggap teks (deteksi, bukan error)
  if (/^[[{]/.test(t)) return validateFormat('json', t) === undefined ? 'json' : 'text';
  return /^[\w"'-][^\n:]*:(\s|$)/m.test(t) && t.includes('\n') ? 'yaml' : 'text';
}

/**
 * pesan error bila value tidak valid untuk formatnya; undefined = boleh disimpan.
 * shortcut: YAML tidak divalidasi (tanpa dependency parser YAML); tambahkan parser bila sering salah simpan YAML.
 */
export function validateFormat(format: 'json' | 'yaml' | 'text', text: string): string | undefined {
  if (format !== 'json') return undefined;
  try {
    JSON.parse(text);
    return undefined;
  } catch (e) {
    // input user (value KV): dilaporkan ke editor, detail di log
    driverLog.error(`consul validateFormat - EXCEPTION CAUGHT | ${e instanceof Error ? e.message : e} - stack-trace: ${e instanceof Error ? e.stack : e}`);
    return `Invalid JSON: ${e instanceof Error ? e.message : e}`;
  }
}

/** backup format `consul kv export` (value tetap base64): restore dengan `consul kv import @file.json` */
export const backupJson = (entries: KvEntry[]) => JSON.stringify(entries.map((e) => ({ key: e.Key, flags: e.Flags ?? 0, value: e.Value ?? '' })), null, 2);

type Fetch = typeof fetch;

export class ConsulClient {
  constructor(private c: ConsulTarget, private token: string, private fetchImpl: Fetch = fetch) {}

  /** request API; 404 = undefined (key / prefix tidak ada); 403 = pesan izin ACL */
  private async call(method: string, path: string, query: Record<string, string | number | true> = {}, body?: string): Promise<string | undefined> {
    const res = await this.fetchImpl(consulUrl(this.c, path, query), {
      method, body, headers: this.token ? { 'X-Consul-Token': this.token } : {},
    } as RequestInit);
    const text = await res.text();
    if (res.status === 404) return undefined;
    if (res.status === 403) throw new Error(`No permission: ${text.trim() || 'Permission denied'} (the ACL token needs key:read for reading, key:write for changes, operator / node / service read for the dashboard)`);
    if (!res.ok) throw new Error(`Consul ${res.status}: ${text.trim()}`);
    return text;
  }
  private async json<T>(path: string, query: Record<string, string | number | true> = {}, def: T): Promise<T> {
    const t = await this.call('GET', path, query);
    return t === undefined ? def : (JSON.parse(t) as T);
  }

  leader = () => this.json<string>('/v1/status/leader', {}, '');
  peers = () => this.json<string[]>('/v1/status/peers', {}, []);
  /** key / folder satu level di bawah prefix ('' = akar) */
  keys = (prefix: string) => this.json<string[]>(kvPath(prefix), { keys: true, separator: '/' }, []);
  /** entri mentah satu key (tanpa prefix lain); [] = tidak ada */
  raw = (key: string) => this.json<KvEntry[]>(kvPath(key), {}, []);
  /** semua entri di bawah prefix (backup sebelum ubah / hapus) */
  export = (prefix: string) => this.json<KvEntry[]>(kvPath(prefix), { recurse: true }, []);

  async get(key: string): Promise<{ key: string; value: string; modifyIndex: number; flags: number; session: string } | undefined> {
    const [e] = await this.json<KvEntry[]>(kvPath(key), {}, []);
    return e && { key: e.Key, value: decodeKv(e), modifyIndex: e.ModifyIndex ?? 0, flags: e.Flags ?? 0, session: e.Session ?? '' };
  }
  /** simpan; cas = ModifyIndex saat dibuka (0 = hanya bila key belum ada); false = sudah diubah orang lain */
  async put(key: string, value: string, cas?: number): Promise<boolean> {
    return (await this.call('PUT', kvPath(key), cas === undefined ? {} : { cas }, value))?.trim() === 'true';
  }
  async delete(key: string, recurse = false): Promise<boolean> {
    return (await this.call('DELETE', kvPath(key), recurse ? { recurse: true } : {}))?.trim() === 'true';
  }

  // dashboard
  members = () => this.json<{ Name: string; Addr: string; Status: number; Tags?: Record<string, string> }[]>('/v1/agent/members', {}, []);
  services = () => this.json<Record<string, string[]>>('/v1/catalog/services', {}, {});
  nodes = () => this.json<{ Node: string; Address: string; Datacenter: string }[]>('/v1/catalog/nodes', {}, []);
  health = () => this.json<{ Node: string; CheckID: string; Name: string; Status: string; ServiceName: string; Output: string }[]>('/v1/health/state/any', {}, []);
}

const SCHEME = 'moonage-consul';
/** uri editor value KV: moonage-consul://<koneksi>/<key> (Ctrl+S = simpan ke Consul) */
export const consulUri = (conn: string, key: string) => `${SCHEME}://${encodeURIComponent(conn)}/${key.split('/').map(encodeURIComponent).join('/')}`;
export function parseConsulUri(uri: string): { conn: string; key: string } {
  const m = new RegExp(`^${SCHEME}://([^/]*)/(.*)$`).exec(uri);
  if (!m) throw new Error(`Not a Consul key: ${uri}`);
  return { conn: decodeURIComponent(m[1]), key: m[2].split('/').map(decodeURIComponent).join('/') };
}

/**
 * simpan value: format divalidasi (mengikuti value lama, atau value baru untuk key baru), value lama di-backup, lalu PUT ?cas=.
 * cas = ModifyIndex saat dibuka (0 = key baru, gagal bila sudah ada). writeBackup(json) -> path file backup.
 */
export async function saveKv(c: ConsulClient, key: string, text: string, cas: number, writeBackup: (json: string) => Promise<string>): Promise<{ backup?: string }> {
  const current = cas > 0 ? await c.raw(key) : [];
  const now = current[0];
  const problem = validateFormat(detectFormat(now ? decodeKv(now) : text), text);
  if (problem) throw new Error(problem);
  if (now && now.ModifyIndex !== undefined && now.ModifyIndex !== cas) throw conflict(key);
  const backup = now ? await writeBackup(backupJson(current)) : undefined;
  if (!(await c.put(key, text, cas))) throw conflict(key);
  return { backup };
}
const conflict = (key: string) => new Error(`"${key}" was changed in Consul since you opened it (or already exists): reopen it to see the current value, then apply your change again`);

/** hapus key / folder (diakhiri /, recurse): semua key di bawahnya di-backup dulu */
export async function deleteKv(c: ConsulClient, key: string, writeBackup: (json: string) => Promise<string>): Promise<{ deleted: number; backup?: string }> {
  const folder = key.endsWith('/');
  const entries = folder ? await c.export(key) : await c.raw(key);
  const backup = entries.length ? await writeBackup(backupJson(entries)) : undefined;
  if (!(await c.delete(key, folder))) throw new Error(`Consul did not delete "${key}"`);
  return { deleted: entries.length, backup };
}

const CONSUL_TEST = '__consul_test__';
/** koneksi tersimpan -> target API (datacenter di field database) */
export const consulTarget = (c: ConnectionInfo): ConsulTarget => ({ host: c.host, port: c.port, ssl: c.ssl, datacenter: c.database || undefined });
const NOT_SQL = 'Consul connections have no SQL: use the Consul KV keys and the Dashboard in Connections';
/** Consul bukan database SQL: driver minimal supaya koneksi bisa disimpan / dipilih; KV & dashboard lewat ConsulClient */
export const consulDriver: Driver = {
  label: 'Consul', defaultPort: 8500, dialect: 'consul', quote: (s) => s, defaultSchema: '', defaultDb: '', testSql: CONSUL_TEST, transactions: false,
  // Test connection (form): leader cluster; teks lain bukan perintah Consul
  async run(conn, password, text) {
    if (text !== CONSUL_TEST) throw new Error(NOT_SQL);
    const leader = await new ConsulClient(consulTarget(conn), password).leader();
    return { resultSets: [{ columns: ['leader', 'datacenter'], rows: [[leader, conn.database || '(agent datacenter)']], total: 1 }], rowsAffected: [], messages: [], durationMs: 0 };
  },
  session: async () => { throw new Error(NOT_SQL); },
  stream: async () => { throw new Error(NOT_SQL); },
  databases: async () => [], objects: async () => [], columns: async () => [], primaryKey: async () => [],
  selectTop: () => '',
  close: async () => undefined,
};

const MEMBER = ['none', 'alive', 'leaving', 'left', 'failed'];
type Health = Awaited<ReturnType<ConsulClient['health']>>;
/** data mentah dashboard (sekali ambil) -> ringkasan untuk tampilan */
export function dashboardSummary(d: {
  leader: string; peers: string[]; members: Awaited<ReturnType<ConsulClient['members']>>; services: Record<string, string[]>;
  nodes: Awaited<ReturnType<ConsulClient['nodes']>>; health: Health;
}) {
  const count = (checks: Health, status: string) => checks.filter((c) => c.Status === status).length;
  const bad = d.health.filter((c) => c.Status !== 'passing');
  return {
    leader: d.leader, peers: d.peers.length,
    members: d.members.map((m) => ({ name: m.Name, address: m.Addr, status: MEMBER[m.Status] ?? String(m.Status) })),
    services: Object.entries(d.services).sort(([a], [b]) => a.localeCompare(b)).map(([name, tags]) => {
      const own = d.health.filter((c) => c.ServiceName === name);
      return { name, tags: tags.join(', '), passing: count(own, 'passing'), warning: count(own, 'warning'), critical: count(own, 'critical') };
    }),
    nodes: d.nodes.map((n) => ({ name: n.Node, address: n.Address, datacenter: n.Datacenter })),
    checks: { passing: count(d.health, 'passing'), warning: count(d.health, 'warning'), critical: count(d.health, 'critical') },
    // critical dulu, lalu warning
    failing: [...bad].sort((a, b) => (a.Status === b.Status ? 0 : a.Status === 'critical' ? -1 : 1))
      .map((c) => ({ node: c.Node, service: c.ServiceName, check: c.Name, status: c.Status, output: c.Output })),
  };
}
export type DashboardSummary = ReturnType<typeof dashboardSummary>;

/** satu sampel dashboard (paralel); dipakai panel Dashboard */
export async function dashboardData(c: ConsulClient): Promise<DashboardSummary> {
  const [leader, peers, members, services, nodes, health] = await Promise.all([c.leader(), c.peers(), c.members(), c.services(), c.nodes(), c.health()]);
  return dashboardSummary({ leader, peers, members, services, nodes, health });
}
