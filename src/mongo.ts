import * as vm from 'vm';
import { randomUUID } from 'crypto';
import { BSON, Binary, Decimal128, Double, Int32, Long, MongoClient, ObjectId } from 'mongodb';
import type { AbstractCursor, Db, Document, MongoClientOptions } from 'mongodb';
import { MAX_ROWS, connectMs, typedOptions } from './db';
import type { ColumnDdl, ConnectionInfo, Driver, NewColumn, NewDatabase, QueryResult, ResultSet, TypeSpec } from './db';

/** satu perintah shell yang direkam: db.<collection>.<method>(args) atau db.<method>(args), plus chain cursor */
export interface Op {
  coll?: string;
  method: string;
  args: unknown[];
  chain: { method: string; args: unknown[] }[];
}

const COLL_METHODS = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'distinct', 'insertOne', 'insertMany',
  'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'createIndex', 'dropIndex', 'indexes', 'drop']);
const DB_METHODS = new Set(['runCommand', 'adminCommand', 'getCollectionNames', 'getName', 'version', 'getMongo', 'stats', 'createCollection']);
const CURSOR_METHODS = new Set(['sort', 'limit', 'skip', 'project', 'projection', 'hint', 'batchSize', 'explain', 'toArray', 'pretty']);

/** objek / array / regex dari context vm -> objek realm extension (prototype normal untuk serializer BSON); tipe BSON dibiarkan */
function hostify(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(hostify);
  if (Object.prototype.toString.call(v) === '[object RegExp]') return new RegExp((v as RegExp).source, (v as RegExp).flags);
  if (v && typeof v === 'object' && Object.getPrototypeOf(Object.getPrototypeOf(v) ?? Object.prototype) === null && !(v instanceof Object)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hostify(x)]));
  }
  return v;
}

/**
 * Teks gaya mongosh -> daftar perintah, mis. `db.users.find({ age: { $gt: 30 } }).sort({ name: 1 }).limit(5);`.
 * Teks dijalankan sebagai JavaScript di context vm terpisah (variabel, ObjectId(), ISODate() boleh); `db` hanya merekam panggilan,
 * query dikirim ke server sesudahnya. shortcut: vm bukan sandbox keamanan, sama seperti menjalankan script mongosh milik sendiri.
 */
export function parseShell(text: string): Op[] {
  const ops: Op[] = [];
  const cursor = (op: Op): unknown => new Proxy({}, {
    get: (_, m) => (typeof m !== 'string' ? undefined : (...args: unknown[]) => {
      if (!CURSOR_METHODS.has(m)) throw new Error(`.${m}() is not supported after ${op.method}()`);
      op.chain.push({ method: m, args: args.map(hostify) });
      return cursor(op);
    }),
  });
  const record = (op: Op) => {
    ops.push(op);
    return cursor(op);
  };
  // db.a.b -> collection "a.b" selama b bukan nama method
  const coll = (name: string): unknown => new Proxy({}, {
    get: (_, m) => (typeof m !== 'string' ? undefined
      : COLL_METHODS.has(m) ? (...args: unknown[]) => record({ coll: name, method: m, args: args.map(hostify), chain: [] }) : coll(`${name}.${m}`)),
  });
  const db = new Proxy({}, {
    get: (_, m) => (typeof m !== 'string' ? undefined
      : m === 'getCollection' ? (n: unknown) => coll(String(n))
        : DB_METHODS.has(m) ? (...args: unknown[]) => record({ method: m, args: args.map(hostify), chain: [] }) : coll(m)),
  });
  // function biasa (bukan arrow) supaya `new ObjectId(...)` juga jalan
  const helpers = {
    ObjectId: function (h?: string) { return new ObjectId(h); },
    ISODate: function (s?: string) { return s ? new Date(s) : new Date(); },
    NumberLong: function (v: unknown) { return Long.fromString(String(v)); },
    NumberInt: function (v: unknown) { return new Int32(Number(v)); },
    NumberDecimal: function (v: unknown) { return Decimal128.fromString(String(v)); },
  };
  vm.runInNewContext(text, { db, Date, ...helpers, print: () => undefined }, { timeout: 5000, filename: 'query.mongodb' });
  if (!ops.length) throw new Error('No MongoDB command found. Example: db.users.find({ active: true }).limit(10);');
  return ops;
}

const BSON_TYPE = (v: unknown): string => v === null || v === undefined ? '' : v instanceof ObjectId ? 'objectId' : v instanceof Date ? 'date'
  : v instanceof Long ? 'long' : v instanceof Decimal128 ? 'decimal' : v instanceof Int32 ? 'int' : v instanceof Double ? 'double'
    : v instanceof Binary ? 'binData' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'double')
      : typeof v === 'boolean' ? 'bool' : typeof v === 'string' ? 'string' : 'object';

/** nilai BSON -> nilai grid: ObjectId hex, tanggal ISO, angka besar sebagai teks, objek / array sebagai JSON */
export function cellValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof ObjectId) return v.toHexString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Long || v instanceof Decimal128) return v.toString();
  if (v instanceof Int32 || v instanceof Double) return v.valueOf();
  if (v instanceof Binary) return new Uint8Array(v.buffer);
  if (typeof v === 'object') return BSON.EJSON.stringify(v as Document, { relaxed: true });
  return v;
}

/** dokumen -> result set: kolom = gabungan field level atas (urut kemunculan), field yang tidak ada = null */
export function toSet(docs: Document[], total = docs.length, limited?: number): ResultSet {
  const shown = docs.slice(0, MAX_ROWS);
  const columns = [...new Set(shown.flatMap((d) => Object.keys(d)))];
  return {
    columns,
    types: columns.map((c) => BSON_TYPE(shown.find((d) => d[c] !== undefined && d[c] !== null)?.[c])),
    rows: shown.map((d) => columns.map((c) => cellValue(d[c]))),
    total,
    ...(limited ? { limited } : {}),
  };
}

const clients = new Map<string, Promise<MongoClient>>();

/** opsi MongoClient: login, TLS, timeout, Driver settings (mis. replicaSet, retryWrites) */
export const mongoOptions = (conn: ConnectionInfo, password: string): MongoClientOptions => ({
  ...typedOptions(conn.options),
  ...(conn.user ? { auth: { username: conn.user, password } } : {}),
  ...(conn.authSource ? { authSource: conn.authSource } : {}),
  ...(conn.ssl ? { tls: true, tlsAllowInvalidCertificates: conn.trustServerCertificate } : {}),
  serverSelectionTimeoutMS: connectMs(conn), connectTimeoutMS: connectMs(conn),
});

function client(conn: ConnectionInfo, password: string): Promise<MongoClient> {
  let c = clients.get(conn.name);
  if (!c) {
    // host boleh connection string lengkap (mongodb:// / mongodb+srv:// untuk Atlas); user / password dari form
    const url = /^mongodb(\+srv)?:\/\//.test(conn.host) ? conn.host : `mongodb://${conn.host}:${conn.port}`;
    c = new MongoClient(url, mongoOptions(conn, password)).connect();
    clients.set(conn.name, c);
    c.catch(() => clients.delete(conn.name)); // gagal connect: coba ulang di run berikutnya (error dilaporkan pemanggil)
  }
  return c;
}

const dbOf = async (conn: ConnectionInfo, password: string, db?: string) => (await client(conn, password)).db((db ?? conn.database) || 'test');

const isCursor = (op: Op) => op.method === 'find' || op.method === 'aggregate';
/** auto limit hanya untuk satu find / aggregate tanpa .limit() sendiri */
const ownLimit = (op: Op) => op.chain.some((c) => c.method === 'limit');

function makeCursor(db: Db, op: Op, comment: string): AbstractCursor {
  const coll = db.collection(op.coll!);
  let cur: AbstractCursor = op.method === 'find'
    ? coll.find((op.args[0] ?? {}) as Document, { comment, ...(op.args[1] ? { projection: op.args[1] as Document } : {}) })
    : coll.aggregate((op.args[0] ?? []) as Document[], { comment, ...(op.args[1] as Document) });
  for (const c of op.chain) {
    const [a] = c.args as never[];
    if (c.method === 'sort') cur = (cur as never as { sort(x: unknown): AbstractCursor }).sort(a);
    else if (c.method === 'limit') cur = (cur as never as { limit(n: number): AbstractCursor }).limit(a);
    else if (c.method === 'skip') cur = (cur as never as { skip(n: number): AbstractCursor }).skip(a);
    else if (c.method === 'project' || c.method === 'projection') cur = (cur as never as { project(x: unknown): AbstractCursor }).project(a);
    else if (c.method === 'hint') cur = (cur as never as { hint(x: unknown): AbstractCursor }).hint(a);
    else if (c.method === 'batchSize') cur = cur.batchSize(a);
  }
  return cur;
}

/** jalankan satu perintah; cursor dibaca maksimal MAX_ROWS dokumen (atau limit) lalu ditutup */
async function execOp(db: Db, op: Op, comment: string, onCursor: (c: AbstractCursor) => void, limit?: number, skip = 0): Promise<ResultSet> {
  if (op.coll && isCursor(op)) {
    let cur = makeCursor(db, op, comment);
    const explain = op.chain.find((c) => c.method === 'explain');
    if (explain) return toSet([await (cur as never as { explain(v: unknown): Promise<Document> }).explain(explain.args[0] ?? 'queryPlanner')]);
    const auto = limit && !ownLimit(op);
    if (auto) cur = (cur as never as { skip(n: number): { limit(n: number): AbstractCursor } }).skip(skip).limit(limit - skip);
    onCursor(cur);
    const docs: Document[] = [];
    try {
      for await (const d of cur) {
        docs.push(d);
        if (docs.length >= MAX_ROWS) break; // tanpa limit: berhenti di MAX_ROWS (koleksi besar tidak dibaca habis)
      }
    } finally {
      await cur.close();
    }
    if (auto) return toSet(docs, skip + docs.length, docs.length >= limit - skip ? limit : undefined);
    return toSet(docs, docs.length, docs.length >= MAX_ROWS ? MAX_ROWS : undefined);
  }
  const coll = op.coll ? db.collection(op.coll) : undefined;
  const [a, b, c] = op.args as Document[];
  const opts = { comment, ...c };
  switch (op.method) {
    case 'findOne': return toSet([await coll!.findOne(a ?? {}, { comment, ...(b ? { projection: b } : {}) })].filter(Boolean) as Document[]);
    case 'countDocuments': return toSet([{ count: await coll!.countDocuments(a ?? {}, { comment, ...b }) }]);
    case 'estimatedDocumentCount': return toSet([{ count: await coll!.estimatedDocumentCount() }]);
    case 'distinct': return toSet((await coll!.distinct(String(a), (b ?? {}) as Document, { comment })).map((value) => ({ value })));
    case 'insertOne': return toSet([await coll!.insertOne(a, { comment, ...b })]);
    case 'insertMany': return toSet([await coll!.insertMany(a as unknown as Document[], { comment, ...b })]);
    case 'updateOne': return toSet([await coll!.updateOne(a, b, opts)]);
    case 'updateMany': return toSet([await coll!.updateMany(a, b, opts)]);
    case 'replaceOne': return toSet([await coll!.replaceOne(a, b, opts)]);
    case 'deleteOne': return toSet([await coll!.deleteOne(a, { comment, ...b })]);
    case 'deleteMany': return toSet([await coll!.deleteMany(a, { comment, ...b })]);
    case 'createIndex': return toSet([{ name: await coll!.createIndex(a, b) }]);
    case 'dropIndex': return toSet([await coll!.dropIndex(String(a))]);
    case 'indexes': return toSet(await coll!.indexes());
    case 'drop': return toSet([{ dropped: await coll!.drop() }]);
    case 'runCommand': return toSet([await db.command(a, { comment } as Document)]);
    case 'adminCommand': return toSet([await db.admin().command(a)]);
    case 'getCollectionNames': return toSet((await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => ({ name: x.name })));
    case 'getName': return toSet([{ name: db.databaseName }]);
    case 'version': return toSet([{ version: (await db.admin().command({ buildInfo: 1 })).version }]);
    case 'stats': return toSet([await db.stats()]);
    case 'createCollection': return toSet([{ created: (await db.createCollection(String(a), b)).collectionName }]);
    case 'getMongo': {
      const hello = await db.admin().command({ hello: 1 });
      return toSet([{ server: hello.me ?? hello.hosts?.[0] ?? 'mongod', db: db.databaseName }]);
    }
  }
  throw new Error(`${op.method}() is not supported`);
}

/**
 * cancel: cursor ditutup dan operasi di server yang ditandai comment run ini dihentikan (killOp, butuh hak lihat / kill operasi).
 * Gagal killOp ditempelkan ke error hasil (dicatat pemanggil).
 */
async function killByComment(db: Db, comment: string): Promise<void> {
  const admin = db.admin();
  const cur = await admin.command({ currentOp: true, 'command.comment': comment });
  await Promise.all((cur.inprog as { opid: unknown }[]).map((o) => admin.command({ killOp: 1, op: o.opid })));
}

async function run(conn: ConnectionInfo, password: string, text: string, signal?: AbortSignal, limit?: number, skip = 0): Promise<QueryResult> {
  signal?.throwIfAborted();
  const start = Date.now();
  const ops = parseShell(text);
  const db = await dbOf(conn, password);
  const out: QueryResult = { resultSets: [], rowsAffected: [], messages: [], durationMs: 0 };
  const comment = `moonage-${randomUUID()}`;
  let cursor: AbstractCursor | undefined;
  let killFailed: unknown;
  const cancel = () => {
    void cursor?.close();
    killByComment(db, comment).catch((e: unknown) => (killFailed = e));
  };
  signal?.addEventListener('abort', cancel);
  try {
    for (const op of ops) {
      signal?.throwIfAborted();
      out.resultSets.push(await execOp(db, op, comment, (c) => (cursor = c), ops.length === 1 ? limit : undefined, skip));
    }
    signal?.throwIfAborted();
  } catch (e) {
    if (killFailed && e instanceof Error) e.message += ` (cancel failed: ${killFailed instanceof Error ? killFailed.message : killFailed})`;
    throw e;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  out.durationMs = Date.now() - start;
  return out;
}

const coll = (o: { name: string }) => `db.getCollection(${JSON.stringify(o.name)})`;
const key = (name: string) => JSON.stringify(name);

/** tipe BSON yang bisa dituju $convert */
const CONVERTIBLE = ['string', 'int', 'long', 'double', 'decimal', 'bool', 'date', 'objectId'];
const NOT_NULL_DEFAULT = 'Not null needs a default (value for documents without the field)';

/**
 * editor Columns MongoDB: "kolom" = field level atas dari sampel dokumen; Add / Edit / Delete = updateMany ke dokumen yang ada.
 * shortcut: hanya field level atas (bukan field bersarang), tipe dari sampel 100 dokumen.
 */
export const mongoColumnDdl: ColumnDdl = {
  separator: '\n',
  newType: 'string',
  note: 'MongoDB has no schema: each step updates the existing documents (updateMany), without a transaction. Steps before a failing step stay applied.',
  types: [
    ...CONVERTIBLE.map((name): TypeSpec => ({ name, group: 'BSON', note: 'existing values converted with $convert; failures become null' })),
    ...['array', 'object', 'binData', 'null'].map((name): TypeSpec => ({ name, group: 'BSON (no conversion)', note: 'only for new fields' })),
  ],
  // total dokumen sampel = jumlah dokumen yang punya _id (selalu ada)
  show: (o) => `db.getCollection(${JSON.stringify(o.name)}).aggregate([
  { $sample: { size: 100 } },
  { $project: { kv: { $objectToArray: "$$ROOT" } } },
  { $unwind: { path: "$kv", includeArrayIndex: "pos" } },
  { $group: { _id: "$kv.k", types: { $addToSet: { $type: "$kv.v" } }, n: { $sum: 1 }, pos: { $min: "$pos" } } },
  { $group: { _id: null, fields: { $push: "$$ROOT" }, total: { $max: "$n" } } },
  { $unwind: "$fields" },
  { $replaceWith: { $mergeObjects: ["$fields", { total: "$total" }] } },
  { $sort: { pos: 1, _id: 1 } },
  { $project: { _id: 0, ordinal: { $add: ["$pos", 1] }, column_name: "$_id",
    data_type: { $let: { vars: { t: { $setDifference: ["$types", ["null"]] } }, in: { $cond: [{ $eq: [{ $size: "$$t" }, 0] }, "null",
      { $reduce: { input: "$$t", initialValue: "", in: { $concat: ["$$value", { $cond: [{ $eq: ["$$value", ""] }, "", "|"] }, "$$this"] } } }] } } },
    nullable: { $cond: [{ $and: [{ $eq: ["$n", "$total"] }, { $not: [{ $in: ["null", "$types"] }] }] }, "NO", "YES"] },
    default_value: { $literal: null },
    present: { $concat: [{ $toString: { $round: [{ $multiply: [{ $divide: ["$n", "$total"] }, 100] }, 0] } }, "%"] },
    identity: { $cond: [{ $eq: ["$_id", "_id"] }, "auto", null] } } }
]);`,
  add: (o, c) => `${coll(o)}.updateMany({ ${key(c.name)}: { $exists: false } }, { $set: { ${key(c.name)}: ${c.default?.trim() || 'null'} } });`,
  drop: (o, name) => `${coll(o)}.updateMany({ ${key(name)}: { $exists: true } }, { $unset: { ${key(name)}: "" } });`,
  edit(o, old, next) {
    const [k, ty, d] = [key(next.name), next.type.trim(), next.default?.trim() || ''];
    const steps = [
      ...(next.name !== old.name ? [`${coll(o)}.updateMany({ ${key(old.name)}: { $exists: true } }, { $rename: { ${key(old.name)}: ${k} } });`] : []),
      ...(ty !== old.type ? [`${coll(o)}.updateMany({ ${k}: { $exists: true } }, [{ $set: { ${k}: { $convert: { input: ${JSON.stringify(`$${next.name}`)}, to: ${JSON.stringify(ty)}, onError: null, onNull: null } } } }]);`] : []),
      // Not null / Default = nilai untuk dokumen tanpa field (Not null: juga yang null); tidak ada constraint
      ...(d && (d !== (old.default?.trim() || '') || (!next.nullable && old.nullable))
        ? [`${coll(o)}.updateMany(${next.nullable ? `{ ${k}: { $exists: false } }` : `{ $or: [{ ${k}: { $exists: false } }, { ${k}: null }] }`}, { $set: { ${k}: ${d} } });`] : []),
    ];
    if (steps.length) return steps.join('\n');
    return next.nullable !== old.nullable || d !== (old.default?.trim() || '') ? `// ${key(old.name)}: MongoDB has no constraint, documents unchanged` : `// no changes to ${key(old.name)}`;
  },
  // New Collection: createCollection + validator $jsonSchema (Not null = required); _id tidak ditulis (selalu ada); schema diabaikan
  create(o, cols) {
    const fields = cols.filter((c) => c.name !== '_id');
    const required = fields.filter((c) => !c.nullable).map((c) => key(c.name));
    const opts = !fields.length ? '' : `, { validator: { $jsonSchema: { bsonType: "object", ${required.length ? `required: [${required.join(', ')}], ` : ''}properties: {
${fields.map((c) => `  ${key(c.name)}: { bsonType: ${key(c.type)} }`).join(',\n')}
} } } }`;
    return [`db.createCollection(${key(o.name)}${opts});`,
      ...fields.filter((c) => c.unique).map((c) => `${coll(o)}.createIndex({ ${key(c.name)}: 1 }, { unique: true, name: ${key(`UQ_${o.name}_${c.name}`)} });`)].join('\n');
  },
  check(c, old, create) {
    if (c.name.includes('.') || c.name.startsWith('$')) return 'field name cannot contain "." or start with "$"';
    if (create) {
      if (c.default) return 'MongoDB has no column defaults (set values when inserting)';
      return (c as NewColumn).pk && c.name !== '_id' ? 'only _id is the primary key in MongoDB' : undefined;
    }
    if (old && c.type !== old.type && !CONVERTIBLE.includes(c.type)) return `cannot convert existing values to ${c.type} (use ${CONVERTIBLE.slice(0, -1).join(', ')} or ${CONVERTIBLE.at(-1)})`;
    if (!c.nullable && !c.default && (!old || old.nullable)) return NOT_NULL_DEFAULT;
    return undefined;
  },
};

/** New Database: MongoDB membuat database saat koleksi pertama dibuat; script dijalankan di database baru */
export const mongoNewDatabase: NewDatabase = {
  maxName: 63,
  useNewDatabase: true,
  fields: [{ key: 'collection', label: 'First collection', kind: 'text', hint: 'MongoDB creates the database with its first collection' }],
  checkName: (name) => (/[/\\. "$*<>:|?]/.test(name) ? 'Database name cannot contain / \\ . " $ * < > : | ? or spaces' : undefined),
  check: (v) => [
    !v.collection ? 'First collection is required'
      : v.collection.startsWith('system.') || v.collection.includes('$') ? 'Collection name cannot start with "system." or contain "$"' : '',
  ].filter(Boolean),
  script: (_name, v) => `db.createCollection(${key(v.collection)});`,
};

export const mongoDriver: Driver = {
  label: 'MongoDB',
  defaultPort: 27017,
  dialect: 'mongodb',
  quote: (s) => JSON.stringify(s),
  defaultSchema: 'db', // objek ditampilkan / dilengkapi sebagai db.<collection>
  defaultDb: 'test',
  testSql: 'db.getMongo()',
  transactions: false,
  columnDdl: mongoColumnDdl,
  newDatabase: mongoNewDatabase,
  explain: (s, mode) => `${s}.explain(${JSON.stringify(mode === 'estimated' ? 'queryPlanner' : 'executionStats')})`,
  autoLimitable: (stmts) => {
    if (stmts.length !== 1) return false;
    try {
      const ops = parseShell(stmts[0]);
      return ops.length === 1 && isCursor(ops[0]) && !ownLimit(ops[0]) && !ops[0].chain.some((c) => c.method === 'explain');
    } catch {
      return false; // teks belum valid: run yang akan melaporkan error-nya
    }
  },
  run,
  async session() {
    throw new Error('Manual transactions are not supported for MongoDB connections (use Auto-commit)');
  },
  async stream(conn, password, text, signal, sink) {
    const [op] = parseShell(text);
    if (!op?.coll || !isCursor(op)) throw new Error('Export all data needs a find() or aggregate() query');
    const cur = makeCursor(await dbOf(conn, password), op, `moonage-${randomUUID()}`);
    const close = () => void cur.close();
    signal?.addEventListener('abort', close);
    try {
      // shortcut: kolom diambil dari 1000 dokumen pertama; field yang baru muncul sesudahnya tidak ikut di-export
      const head: Document[] = [];
      for await (const d of cur) {
        head.push(d);
        if (head.length >= MAX_ROWS) break;
      }
      const { columns } = toSet(head);
      await sink.columns(columns);
      const row = (d: Document) => sink.row(columns.map((c) => cellValue(d[c])));
      for (const d of head) await row(d);
      let n = head.length;
      if (head.length >= MAX_ROWS) {
        for await (const d of cur) {
          await row(d);
          n++;
        }
      }
      signal?.throwIfAborted();
      return n;
    } finally {
      signal?.removeEventListener('abort', close);
      await cur.close();
    }
  },
  async databases(conn, password) {
    const r = await (await client(conn, password)).db('admin').admin().listDatabases({ nameOnly: true });
    return r.databases.map((d) => d.name).sort();
  },
  async objects(conn, password, db, kind) {
    if (kind === 'procedure') return [];
    const list = await (await dbOf(conn, password, db)).listCollections({ type: kind === 'table' ? 'collection' : 'view' }, { nameOnly: true }).toArray();
    return list.filter((c) => !c.name.startsWith('system.')).map((c) => ({ schema: 'db', name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
  },
  async columns(conn, password, db, obj) {
    // shortcut: field diambil dari satu dokumen contoh (koleksi tanpa skema tetap)
    const doc = await (await dbOf(conn, password, db)).collection(obj.name).findOne({});
    return Object.entries(doc ?? {}).map(([name, v]) => ({ name, type: BSON_TYPE(v), nullable: true }));
  },
  primaryKey: async () => ['_id'],
  selectTop: (_db, obj, n) => `db.getCollection(${JSON.stringify(obj.name)}).find({}).limit(${n});`,
  isOpen: (name) => clients.has(name),
  async close(name) {
    const c = clients.get(name);
    clients.delete(name);
    if (c) await (await c).close();
  },
};
