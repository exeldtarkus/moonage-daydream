import { randomBytes } from 'crypto';
import { esc } from './resultsHtml';
import { webviewPage } from './webviewPage';

/**
 * form Add Data (tab): satu baris isian per kolom, script INSERT live di bawah.
 * ext -> page: { type: 'init', columns: {name, type, nullable, generated, default}[] } | { type: 'script', sql, errors } | { type: 'status', text, error? } | { type: 'inserted', text }
 * page -> ext: { type: 'ready' } | { type: 'change' | 'insert' | 'open', entries: { [kolom]: { value, isNull } } }
 */
export function addDataHtml(cspSource: string, t: { conn: string; table: string; type: string }, readOnly: boolean): string {
  const nonce = randomBytes(16).toString('base64');
  return webviewPage('addData', {
    cspSource,
    nonce,
    conn: esc(t.conn),
    table: esc(t.table),
    type: esc(t.type),
    roNote: readOnly ? '<p class="ro">Read-only connection: rows cannot be inserted here, use Open in SQL Editor to get the script.</p>' : '',
    insertBtn: readOnly ? '' : '<button id="insert" class="primary" disabled>Insert</button>',
  });
}
