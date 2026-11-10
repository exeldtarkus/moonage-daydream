import { randomBytes } from 'crypto';
import { esc } from './resultsHtml';
import { pageJson, webviewPage } from './webviewPage';

/**
 * editor Columns (klik kanan tabel), seperti DBeaver: grid kolom bisa diedit (nama, tipe dari dropdown + ukuran, NOT NULL, default,
 * tambah / hapus), daftar Pending changes berisi langkah SQL yang akan dijalankan; Execute / Open in SQL Editor / Revert.
 * ext -> page: { type: 'load', cols, info, types, capabilities } | { type: 'script', sql, errors, count, steps } | { type: 'status', text, error? }
 * page -> ext: { type: 'ready' | 'refresh' | 'fkTables' | 'copy' (as: 'script' | 'json') } | { type: 'change' | 'execute' | 'open' | 'fkColumns', rows?, table?, schema?, name? }
 * FK responses carry the tables / columns needed by the editor.
 */
export function columnsHtml(cspSource: string, t: { conn: string; db: string; table: string }, readOnly: boolean, mode: 'edit' | 'create' = 'edit'): string {
  const create = mode === 'create';
  const nonce = randomBytes(16).toString('base64');
  return webviewPage('columns', {
    cspSource,
    nonce,
    table: esc(t.table),
    conn: esc(t.conn),
    db: esc(t.db),
    newName: create ? '<div class="newname"><select id="tableSchema" aria-label="Schema"></select><span aria-hidden="true">.</span><input type="text" id="tableName" placeholder="table_name" aria-label="Table name" spellcheck="false" autocomplete="off" autofocus></div>' : '',
    roNote: readOnly ? '<span class="ro">Read-only connection: columns cannot be changed</span>' : '',
    refreshBtn: create ? '' : '<button id="refresh" title="Reload columns from the server and discard unsaved changes">Refresh</button>',
    copyBtn: create ? '' : '<span class="copywrap"><button id="copy" aria-haspopup="menu" aria-expanded="false" title="Copy this table definition">Copy ▾</button>'
      + '<div id="copyMenu" role="menu" hidden><button role="menuitem" data-as="script">Copy as script</button><button role="menuitem" data-as="json">Copy as JSON</button></div></span>',
    addColBtn: readOnly ? '' : '<button id="addCol">Add column</button>',
    loadingText: create ? '' : 'Loading columns…',
    roHidden: readOnly ? ' hidden' : '',
    pendingTitle: create ? 'Script' : 'Pending changes',
    revertBtn: create ? '' : '<button id="revert" title="Discard all changes">Revert</button>',
    executeBtn: readOnly ? '' : `<button id="execute" class="primary" title="Run the script on the server">${create ? 'Create' : 'Execute'}</button>`,
    data: pageJson({ readOnly, mode }),
  });
}
