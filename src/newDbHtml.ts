import { randomBytes } from 'crypto';
import { esc } from './resultsHtml';
import { webviewPage } from './webviewPage';

/**
 * form New Database (tab): nama + isian dari driver (NewDatabase.fields), bagian group bisa dilipat, script live di bawah.
 * ext -> page: { type: 'init', fields } | { type: 'script', sql, errors } | { type: 'status', text, error? }
 * page -> ext: { type: 'ready' } | { type: 'change' | 'create' | 'open', name, values }
 */
/** dipakai juga untuk New Linked Server (t.title); isian kind password = input tersembunyi */
export function newDbHtml(cspSource: string, t: { conn: string; type: string; title?: string }, readOnly: boolean): string {
  const nonce = randomBytes(16).toString('base64');
  return webviewPage('newDb', {
    cspSource,
    nonce,
    title: esc(t.title ?? 'New Database'),
    conn: esc(t.conn),
    type: esc(t.type),
    roNote: readOnly ? '<p class="ro">Read-only connection: it cannot be created here, use Open in SQL Editor to get the script.</p>' : '',
    createBtn: readOnly ? '' : '<button id="create" class="primary" disabled>Create</button>',
  });
}
