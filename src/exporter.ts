import { createReadStream, createWriteStream, promises as fsp, WriteStream } from 'fs';
import { once } from 'events';
import { createDeflateRaw, deflateRawSync } from 'zlib';

export type ExportFormat = 'xlsx' | 'csv' | 'tsv' | 'json' | 'jsonPretty' | 'markdown' | 'html';
export const FORMATS: Record<ExportFormat, { label: string; ext: string }> = {
  xlsx: { label: 'Excel (.xlsx)', ext: 'xlsx' },
  csv: { label: 'CSV', ext: 'csv' },
  tsv: { label: 'TSV (tab separated)', ext: 'tsv' },
  json: { label: 'JSON', ext: 'json' },
  jsonPretty: { label: 'JSON (pretty)', ext: 'json' },
  markdown: { label: 'Markdown', ext: 'md' },
  html: { label: 'HTML', ext: 'html' },
};
/** batas baris Copy All Data ke clipboard (teks disimpan di memori) */
export const CLIPBOARD_MAX_ROWS = 100_000;
/** batas baris satu sheet Excel (tanpa header) */
export const XLSX_MAX_ROWS = 1_048_575;

/** penulis file export baris demi baris (All Data di-stream dari server, memori tetap kecil) */
export interface Sink {
  row(values: unknown[]): Promise<void> | void;
  end(): Promise<void>;
  /** hapus file setengah jadi (export dibatalkan / gagal) */
  abort(): Promise<void>;
}

/** nilai sel untuk export: angka / boolean apa adanya, tanggal ISO, biner 0x.., objek JSON */
export function plain(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString('hex').toUpperCase()}`;
  return JSON.stringify(v);
}

/** nama kolom unik untuk key JSON (kolom kembar diberi akhiran _2, _3) */
export function uniqueNames(cols: string[]): string[] {
  const seen = new Map<string, number>();
  return cols.map((c) => {
    const n = (seen.get(c) ?? 0) + 1;
    seen.set(c, n);
    return n === 1 ? c : `${c}_${n}`;
  });
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// karakter kontrol tidak valid di XML 1.0
// eslint-disable-next-line no-control-regex
const escXml = (s: string) => escHtml(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const csvCell = (v: ReturnType<typeof plain>) => {
  if (v === null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** TSV: tab / baris baru di dalam nilai diganti spasi supaya paste ke spreadsheet tetap satu sel */
const tsvCell = (v: ReturnType<typeof plain>) => (v === null ? '' : String(v).replace(/[\t\r\n]+/g, ' '));
const mdCell = (v: ReturnType<typeof plain>) => (v === null ? 'NULL' : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'));

interface Writer {
  write(s: string): Promise<void> | void;
  close(): Promise<void>;
}

class Out implements Writer {
  constructor(readonly ws: WriteStream) {}
  /** tulis dengan backpressure: tunggu drain bila buffer penuh */
  write(s: string): Promise<void> | void {
    if (!this.ws.write(s)) return once(this.ws, 'drain').then(() => undefined);
  }
  async close(): Promise<void> {
    this.ws.end();
    await once(this.ws, 'close');
  }
}

export async function openSink(format: ExportFormat, file: string, columns: string[]): Promise<Sink> {
  if (format === 'xlsx') return xlsxSink(file, columns);
  const out = new Out(createWriteStream(file));
  await once(out.ws, 'open');
  return textSink(format, columns, out, async () => {
    out.ws.destroy();
    await fsp.rm(file, { force: true });
  });
}

/** Copy ke clipboard: format teks yang sama, ditampung di memori; header false = hanya baris (Ctrl+C di grid) */
export async function memorySink(format: Exclude<ExportFormat, 'xlsx'>, columns: string[], header = true): Promise<Sink & { text(): string }> {
  const chunks: string[] = [];
  const sink = await textSink(format, columns, { write: (s) => void chunks.push(s), close: async () => undefined }, async () => undefined, header);
  return { ...sink, text: () => chunks.join('') };
}

async function textSink(format: Exclude<ExportFormat, 'xlsx'>, columns: string[], out: Writer, abort: () => Promise<void>, header = true): Promise<Sink> {
  const names = uniqueNames(columns);
  let n = 0;
  const obj = (values: unknown[]) => Object.fromEntries(names.map((k, i) => [k, plain(values[i])]));
  switch (format) {
    case 'csv':
      await out.write(`${out instanceof Out ? '\uFEFF' : ''}${columns.map((c) => csvCell(c)).join(',')}\r\n`); // BOM (file saja): Excel membaca UTF-8
      return { row: (v) => out.write(`${v.map((x) => csvCell(plain(x))).join(',')}\r\n`), end: () => out.close(), abort };
    case 'json':
      await out.write('[');
      return {
        row: (v) => out.write(`${n++ ? ',' : ''}${JSON.stringify(obj(v))}`),
        end: async () => { await out.write(']\n'); await out.close(); },
        abort,
      };
    case 'jsonPretty':
      await out.write('[');
      return {
        row: (v) => out.write(`${n++ ? ',' : ''}\n  ${JSON.stringify(obj(v), null, 2).replace(/\n/g, '\n  ')}`),
        end: async () => { await out.write(n ? '\n]\n' : ']\n'); await out.close(); },
        abort,
      };
    case 'tsv':
      if (header) await out.write(`${columns.map((c) => tsvCell(c)).join('\t')}\r\n`);
      return { row: (v) => out.write(`${v.map((x) => tsvCell(plain(x))).join('\t')}\r\n`), end: () => out.close(), abort };
    case 'markdown':
      await out.write(`| ${columns.map((c) => mdCell(c)).join(' | ')} |\n|${columns.map(() => ' --- ').join('|')}|\n`);
      return { row: (v) => out.write(`| ${v.map((x) => mdCell(plain(x))).join(' | ')} |\n`), end: () => out.close(), abort };
    case 'html':
      await out.write('<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<title>Export</title>\n<style>\n'
        + 'body { font-family: system-ui, sans-serif; margin: 16px; }\n'
        + 'table { border-collapse: collapse; font-size: 13px; }\n'
        + 'th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; white-space: nowrap; }\n'
        + 'th { background: #f3f3f3; position: sticky; top: 0; }\n.null { color: #999; }\n'
        + `</style>\n</head>\n<body>\n<table>\n<thead><tr>${columns.map((c) => `<th>${escHtml(c)}</th>`).join('')}</tr></thead>\n<tbody>\n`);
      return {
        row: (v) => out.write(`<tr>${v.map((x) => {
          const p = plain(x);
          return p === null ? '<td class="null">NULL</td>' : `<td>${escHtml(String(p))}</td>`;
        }).join('')}</tr>\n`),
        end: async () => { await out.write('</tbody>\n</table>\n</body>\n</html>\n'); await out.close(); },
        abort,
      };
  }
}

/** .xlsx: sheet XML ditulis ke file sementara (stream), lalu dibungkus zip (deflate) bersama file kecil lainnya */
async function xlsxSink(file: string, columns: string[]): Promise<Sink> {
  const tmp = `${file}.sheet.tmp`;
  const out = new Out(createWriteStream(tmp));
  await once(out.ws, 'open');
  let n = 0;
  const cell = (v: unknown, header = false) => {
    const p = plain(v);
    if (p === null) return '<c/>';
    if (typeof p === 'number' && Number.isFinite(p)) return `<c><v>${p}</v></c>`;
    if (typeof p === 'boolean') return `<c t="b"><v>${p ? 1 : 0}</v></c>`;
    return `<c t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${escXml(String(p))}</t></is></c>`;
  };
  await out.write('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">'
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>'
    + `<row>${columns.map((c) => cell(c, true)).join('')}</row>`);
  const abort = async () => {
    out.ws.destroy();
    await Promise.all([fsp.rm(tmp, { force: true }), fsp.rm(file, { force: true })]);
  };
  return {
    row: (v) => {
      if (++n > XLSX_MAX_ROWS) throw new Error(`Excel supports at most ${XLSX_MAX_ROWS} rows per sheet; use CSV / JSON for more`);
      return out.write(`<row>${v.map((x) => cell(x)).join('')}</row>`);
    },
    end: async () => {
      await out.write('</sheetData></worksheet>');
      await out.close();
      try {
        await writeZip(file, [
          { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
            + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
          { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
          { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Result" sheetId="1" r:id="rId1"/></sheets></workbook>' },
          { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
          { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
            + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
            + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
            + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
            + '</styleSheet>' },
          { name: 'xl/worksheets/sheet1.xml', path: tmp },
        ]);
      } finally {
        await fsp.rm(tmp, { force: true });
      }
    },
    abort,
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(buf: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * zip sederhana (deflate) untuk .xlsx; entry `path` di-stream: CRC + kompres ke file sementara, lalu disalin.
 * shortcut: zip32 (maks 4 GB per file / total), cukup untuk 1 sheet Excel (maks ~1 juta baris).
 */
export async function writeZip(file: string, entries: ({ name: string; data: string } | { name: string; path: string })[]): Promise<void> {
  const fh = await fsp.open(file, 'w');
  const central: Buffer[] = [];
  let offset = 0;
  const put = async (b: Buffer) => {
    await fh.write(b);
    offset += b.length;
  };
  try {
    for (const e of entries) {
      let crc = 0;
      let size = 0;
      let deflated: Buffer | undefined;
      let deflatedPath: string | undefined;
      if ('data' in e) {
        const raw = Buffer.from(e.data, 'utf8');
        crc = crc32(raw);
        size = raw.length;
        deflated = deflateRawSync(raw);
      } else {
        deflatedPath = `${e.path}.deflate`;
        const z = createDeflateRaw();
        const w = createWriteStream(deflatedPath);
        z.pipe(w);
        for await (const chunk of createReadStream(e.path)) {
          crc = crc32(chunk as Buffer, crc);
          size += (chunk as Buffer).length;
          if (!z.write(chunk)) await once(z, 'drain');
        }
        z.end();
        await once(w, 'close');
      }
      const compSize = deflated ? deflated.length : (await fsp.stat(deflatedPath!)).size;
      const name = Buffer.from(e.name, 'utf8');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // nama UTF-8
      local.writeUInt16LE(8, 8); // deflate
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compSize, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(name.length, 26);
      const at = offset;
      await put(Buffer.concat([local, name]));
      if (deflated) await put(deflated);
      else {
        for await (const chunk of createReadStream(deflatedPath!)) await put(chunk as Buffer);
        await fsp.rm(deflatedPath!, { force: true });
      }
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(8, 10);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(compSize, 20);
      cd.writeUInt32LE(size, 24);
      cd.writeUInt16LE(name.length, 28);
      cd.writeUInt32LE(at, 42);
      central.push(Buffer.concat([cd, name]));
    }
    const cdStart = offset;
    const cdBuf = Buffer.concat(central);
    await put(cdBuf);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdBuf.length, 12);
    end.writeUInt32LE(cdStart, 16);
    await put(end);
  } finally {
    await fh.close();
  }
}
