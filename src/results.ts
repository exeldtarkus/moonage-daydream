import * as vscode from 'vscode';
import { CANCEL_COMMAND, Outcome, render } from './resultsHtml';

export type Location = 'panel' | 'right' | 'left';
export const LOCATIONS: { id: Location; label: string }[] = [
  { id: 'panel', label: 'Bottom panel (next to Terminal)' },
  { id: 'right', label: 'Right of the editor' },
  { id: 'left', label: 'Left of the editor' },
];
/** pesan dari script grid: filter WHERE, export */
export interface ResultMessage {
  type: string;
  where?: string;
  part?: number;
  set?: number;
  scope?: 'all' | 'sel';
  rows?: number[];
  cols?: number[];
  format?: string;
  /** copy: false = tanpa baris header (Ctrl+C di grid) */
  header?: boolean;
}
export const VIEW_ID = 'moonageDaydream.results';
const LOCATION_KEY = 'resultsLocation';

/** Tampilkan hasil query di panel bawah (WebviewView) atau di samping editor (WebviewPanel). */
export class Results implements vscode.WebviewViewProvider {
  view: vscode.WebviewView | undefined;
  panel: vscode.WebviewPanel | undefined;
  private last: { title: string; outcome: Outcome } | undefined;

  /** pesan dari script grid (mis. filter WHERE); diisi extension */
  onMessage: ((msg: ResultMessage, outcome: Outcome | undefined) => unknown) | undefined;
  /** tab hasil yang di-pin (snapshot, tidak ditimpa run berikutnya) */
  readonly pinned: { panel: vscode.WebviewPanel; title: string; outcome: Outcome }[] = [];

  constructor(private ctx: vscode.ExtensionContext) {}

  /** hasil yang sedang tampil */
  get current(): { title: string; outcome: Outcome } | undefined {
    return this.last;
  }

  get location(): Location {
    return this.ctx.globalState.get<Location>(LOCATION_KEY, 'panel');
  }

  async setLocation(loc: Location): Promise<void> {
    await this.ctx.globalState.update(LOCATION_KEY, loc);
    if (this.last) await this.show(this.last.title, this.last.outcome);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, enableCommandUris: [CANCEL_COMMAND] }; // script grid (filter / sort / WHERE) + tombol Cancel
    view.webview.onDidReceiveMessage((m) => this.onMessage?.(m, this.last?.outcome));
    view.onDidDispose(() => (this.view = undefined));
    this.paint(view.webview);
  }

  async show(title: string, outcome: Outcome): Promise<void> {
    this.last = { title, outcome };
    const editor = vscode.window.activeTextEditor;
    if (this.location === 'panel') {
      this.panel?.dispose();
      if (this.view) this.view.show(true);
      else await vscode.commands.executeCommand(`${VIEW_ID}.focus`); // view belum pernah dibuka: resolveWebviewView yang menggambar
      if (this.view) this.paint(this.view.webview);
    } else {
      if (this.view) this.view.webview.html = placeholder(this.location);
      if (this.panel && this.panel.viewColumn && editor?.viewColumn && sideOk(this.location, this.panel.viewColumn, editor.viewColumn)) {
        this.panel.reveal(undefined, true);
      } else {
        this.panel?.dispose();
        this.panel = vscode.window.createWebviewPanel(VIEW_ID, 'Results', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: this.location === 'right' },
          { enableScripts: true, enableCommandUris: [CANCEL_COMMAND] });
        this.panel.webview.onDidReceiveMessage((m) => this.onMessage?.(m, this.last?.outcome));
        this.panel.onDidDispose(() => (this.panel = undefined));
        if (this.location === 'left') {
          // panel baru (aktif) ada di group kanan: pindahkan group-nya ke kiri editor
          await vscode.commands.executeCommand('workbench.action.moveActiveEditorGroupLeft');
        }
      }
      this.panel.title = `Results · ${title}`;
      this.paint(this.panel.webview);
    }
    if (editor) await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
  }

  /** Cancel diklik: loading file ini (bila masih tampil) jadi "Cancelling query" + tombol nonaktif; index = satu statement run paralel */
  markCancelling(uri: string, index?: number): void {
    const o = this.last?.outcome;
    if (!o) return;
    const loadings = 'parts' in o ? o.parts.filter((_, i) => index === undefined || i === index).map((p) => p.o) : [o];
    let changed = false;
    for (const l of loadings) {
      if (!('loading' in l) || l.cancelling || ('parts' in o ? o.uri : l.uri) !== uri) continue;
      l.cancelling = true;
      changed = true;
    }
    if (changed) this.repaint(uri);
  }

  /** gambar ulang hasil yang sedang tampil apa pun jenisnya (mis. setelah Load more) */
  refresh(): void {
    const w = this.location === 'panel' ? this.view?.webview : this.panel?.webview;
    if (w && this.last) this.paint(w);
  }

  /** gambar ulang hasil yang sedang tampil (run paralel: statement selesai satu per satu) tanpa memindah fokus */
  repaint(uri: string): void {
    const o = this.last?.outcome;
    if (!o || !('parts' in o ? o.uri === uri : 'loading' in o && o.uri === uri)) return;
    const w = this.location === 'panel' ? this.view?.webview : this.panel?.webview;
    if (w) this.paint(w);
  }

  /** Pin: hasil yang tampil disalin ke tab sendiri di samping (pin berikutnya di sebelahnya -> side by side) */
  pin(): vscode.WebviewPanel | undefined {
    const last = this.last;
    if (!last || 'loading' in last.outcome) return;
    const time = new Date().toLocaleTimeString();
    // pin berikutnya di kolom kanan pin terakhir (grup baru) supaya berdampingan, bukan bertumpuk sebagai tab
    const prev = this.pinned[this.pinned.length - 1]?.panel.viewColumn;
    const panel = vscode.window.createWebviewPanel('moonageDaydream.pinned', `📌 ${last.title} · ${time}`,
      { viewColumn: prev ? prev + 1 : vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true });
    const entry = { panel, title: last.title, outcome: last.outcome };
    this.pinned.push(entry);
    panel.onDidDispose(() => this.pinned.splice(this.pinned.indexOf(entry), 1));
    panel.webview.onDidReceiveMessage((m) => this.onMessage?.(m, entry.outcome));
    panel.webview.html = render(panel.webview.cspSource, `${last.title} · ${time}`, last.outcome, true);
    return panel;
  }

  private paint(w: vscode.Webview) {
    w.html = this.last ? render(w.cspSource, this.last.title, this.last.outcome) : placeholder(undefined);
  }
}

function sideOk(loc: Location, panelCol: number, editorCol: number): boolean {
  return loc === 'right' ? panelCol > editorCol : panelCol < editorCol;
}

function placeholder(loc: Location | undefined): string {
  const msg = loc ? `Results are shown ${loc} of the editor.` : 'Run a query (Ctrl+Alt+Enter) to see results here.';
  return `<!DOCTYPE html><html><body style="opacity:.7;font-family:var(--vscode-font-family);padding:8px 12px">${msg}</body></html>`;
}
