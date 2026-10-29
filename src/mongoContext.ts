/** konteks autocomplete MongoDB dari teks statement sebelum kursor (tanpa vscode: bisa di-unit test) */
export type MongoContext =
  | { kind: 'db'; word: string } // db.|
  | { kind: 'collection'; coll: string; word: string } // db.orders.| / db.getCollection("orders").|
  | { kind: 'cursor'; word: string } // ...find({}).|
  | { kind: 'collectionName'; word: string } // getCollection("|
  | { kind: 'field'; coll: string; word: string } // db.orders.find({ sta|
  | { kind: 'top'; word: string };

/** method shell yang dikenali driver (src/mongo.ts); snippet: $1 = posisi kursor */
export const DB_METHODS: [string, string][] = [
  ['getCollection', 'getCollection("$1")'], ['getCollectionNames', 'getCollectionNames()'], ['getName', 'getName()'], ['version', 'version()'],
  ['stats', 'stats()'], ['runCommand', 'runCommand({ $1 })'], ['adminCommand', 'adminCommand({ $1 })'], ['createCollection', 'createCollection("$1")'],
  ['getMongo', 'getMongo()'],
];
export const COLLECTION_METHODS: [string, string][] = [
  ['find', 'find({ $1 })'], ['findOne', 'findOne({ $1 })'], ['aggregate', 'aggregate([\n\t{ \\$match: { $1 } }\n])'],
  ['countDocuments', 'countDocuments({ $1 })'], ['estimatedDocumentCount', 'estimatedDocumentCount()'], ['distinct', 'distinct("$1")'],
  ['insertOne', 'insertOne({ $1 })'], ['insertMany', 'insertMany([{ $1 }])'], ['updateOne', 'updateOne({ $1 }, { \\$set: { $2 } })'],
  ['updateMany', 'updateMany({ $1 }, { \\$set: { $2 } })'], ['replaceOne', 'replaceOne({ $1 }, { $2 })'], ['deleteOne', 'deleteOne({ $1 })'],
  ['deleteMany', 'deleteMany({ $1 })'], ['createIndex', 'createIndex({ $1: 1 })'], ['dropIndex', 'dropIndex("$1")'], ['indexes', 'indexes()'], ['drop', 'drop()'],
];
export const CURSOR_METHODS: [string, string][] = [
  ['sort', 'sort({ $1: 1 })'], ['limit', 'limit(${1:100})'], ['skip', 'skip($1)'], ['project', 'project({ $1: 1 })'], ['hint', 'hint({ $1 })'],
  ['batchSize', 'batchSize($1)'], ['explain', 'explain("${1|queryPlanner,executionStats|}")'],
];
/** operator query / update / stage aggregate */
export const OPERATORS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$regex', '$and', '$or', '$nor', '$not', '$elemMatch',
  '$size', '$type', '$set', '$unset', '$inc', '$push', '$pull', '$addToSet', '$match', '$group', '$sort', '$project', '$limit', '$skip', '$lookup',
  '$unwind', '$count', '$addFields', '$facet', '$sum', '$avg', '$min', '$max', '$first', '$last'];

const COLL = String.raw`db\s*\.\s*(?:getCollection\(\s*(['"])([^'"]*)\1\s*\)|([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*?))`;
const methodNames = new Set([...COLLECTION_METHODS, ...DB_METHODS].map(([n]) => n));

export function mongoContext(before: string): MongoContext {
  const word = /[$\w]*$/.exec(before)![0];
  const head = before.slice(0, before.length - word.length);
  if (/getCollection\(\s*['"]$/.test(head)) return { kind: 'collectionName', word };
  // di dalam argumen pertama (objek) sebuah method collection: nama field / operator
  const call = new RegExp(`${COLL}\\s*\\.\\s*\\w+\\s*\\(`, 'g');
  let last: RegExpExecArray | undefined;
  for (let m; (m = call.exec(head)); ) last = m;
  if (last && /[{,]\s*$/.test(head)) {
    const inside = head.slice(last.index + last[0].length);
    let depth = 0;
    for (const ch of inside) depth += ch === '(' || ch === '[' || ch === '{' ? 1 : ch === ')' || ch === ']' || ch === '}' ? -1 : 0;
    const coll = last[2] ?? last[3];
    if (depth >= 1 && coll) return { kind: 'field', coll: coll.split('.').filter((p) => !methodNames.has(p)).join('.'), word };
  }
  const coll = new RegExp(`${COLL}\\s*\\.\\s*$`).exec(head);
  if (coll) return { kind: 'collection', coll: coll[2] ?? coll[3], word };
  if (/\)\s*\.\s*$/.test(head)) return { kind: 'cursor', word }; // db.getCollection("x"). sudah ditangani di atas
  if (/\bdb\s*\.\s*$/.test(head)) return { kind: 'db', word };
  return { kind: 'top', word };
}
