import type { Column, DbObject, Driver } from './db';
import { editLiteral } from './sqlContext';

/** isian satu kolom di form Add Data: value kosong (tanpa isNull) = kolom dilewati, server memakai default / identity */
export interface DataEntry { value: string; isNull?: boolean }

/** nilai form Add Data (per tipe BSON) -> literal mongosh */
function mongoLiteral(value: string, type: string, name: string): string {
  const t = type.toLowerCase();
  if (['int', 'long', 'double', 'decimal'].includes(t)) {
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value.trim())) throw new Error(`${name}: "${value}" is not a number (${type})`);
    return value.trim();
  }
  if (t === 'bool') {
    if (!['true', 'false'].includes(value.trim().toLowerCase())) throw new Error(`${name}: "${value}" is not a bool (true / false)`);
    return value.trim().toLowerCase();
  }
  if (t === 'date') {
    if (Number.isNaN(Date.parse(value))) throw new Error(`${name}: "${value}" is not a valid date`);
    return `ISODate(${JSON.stringify(value.trim())})`;
  }
  if (t === 'objectid') {
    if (!/^[0-9a-fA-F]{24}$/.test(value.trim())) throw new Error(`${name}: "${value}" is not a 24-character hex ObjectId`);
    return `ObjectId(${JSON.stringify(value.trim())})`;
  }
  if (t === 'string') return JSON.stringify(value);
  try {
    JSON.parse(value);
    return value.trim();
  } catch {
    if (t === '') return JSON.stringify(value); // tipe tidak diketahui (field null di contoh): anggap teks
    throw new Error(`${name}: "${value}" is not valid JSON (${type})`);
  }
}

/**
 * script INSERT satu baris dari isian form. Kolom generated dilewati; kosong = dilewati (default server);
 * NOT NULL tanpa default wajib diisi. errors tidak kosong = sql kosong.
 */
export function insertScript(d: Pick<Driver, 'dialect' | 'tableRef' | 'quote'>, obj: DbObject, cols: Column[], entries: Record<string, DataEntry>): { sql: string; errors: string[] } {
  const errors: string[] = [];
  const names: string[] = [];
  const values: string[] = [];
  const mongo = d.dialect === 'mongodb';
  for (const c of cols) {
    if (c.generated) continue;
    const e = entries[c.name];
    const empty = !e || (!e.isNull && e.value === '');
    if (empty) {
      if (!c.nullable && c.default === undefined) errors.push(`${c.name} is required (NOT NULL, no default)`);
      continue;
    }
    if (e.isNull && !c.nullable) {
      errors.push(`${c.name} cannot be NULL`);
      continue;
    }
    try {
      names.push(c.name);
      values.push(e.isNull ? 'NULL' : mongo ? mongoLiteral(e.value, c.type, c.name) : editLiteral(e.value, c.type, d.dialect));
    } catch (err) {
      names.pop();
      errors.push(err instanceof Error ? err.message.replace(/^"([^"]*)" is/, `${c.name}: "$1" is`) : String(err));
    }
  }
  if (errors.length) return { sql: '', errors };
  if (mongo) return { sql: `db.getCollection(${JSON.stringify(obj.name)}).insertOne({ ${names.map((n, i) => `${JSON.stringify(n)}: ${values[i] === 'NULL' ? 'null' : values[i]}`).join(', ')} });`, errors };
  const t = d.tableRef!(obj);
  if (!names.length) return { sql: d.dialect === 'mysql' ? `INSERT INTO ${t} () VALUES ();` : `INSERT INTO ${t} DEFAULT VALUES;`, errors };
  return { sql: `INSERT INTO ${t} (${names.map(d.quote).join(', ')})\nVALUES (${values.join(', ')});`, errors };
}
