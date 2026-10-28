import * as vscode from 'vscode';

/** query yang sedang berjalan (satu per file .sql) */
export interface RunningQuery {
  ac: AbortController;
  uri: string;
  conn: string;
  db: string;
  sql: string;
  start: number;
  /** true sejak tombol cancel ditekan sampai server selesai menghentikan query */
  cancelling?: boolean;
  /** run paralel: satu controller per statement (Cancel per statement di panel hasil) */
  parts?: AbortController[];
  /** selesai saat run (termasuk cancel) selesai */
  done?: Promise<unknown>;
}

export interface HistoryEntry {
  sql: string;
  conn: string;
  db: string;
  at: number;
  durationMs: number;
  status: 'ok' | 'error' | 'cancelled';
  message?: string;
}

const HISTORY = 'queryHistory';
export const MAX_HISTORY = 200;

export const firstLine = (sql: string) => {
  const line = sql.trim().split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};
const where = (conn: string, db: string) => (db ? `${conn} / ${db}` : conn);

/** Sidebar "Running Queries": tombol cancel per query; elapsed diperbarui tiap detik selama ada yang berjalan. */
export class RunningView implements vscode.TreeDataProvider<RunningQuery> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private timer: NodeJS.Timeout | undefined;

  constructor(readonly running: Map<string, RunningQuery>) {}

  refresh(): void {
    this.changed.fire();
    if (this.running.size && !this.timer) this.timer = setInterval(() => this.changed.fire(), 1000);
    if (!this.running.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getChildren(q?: RunningQuery): RunningQuery[] {
    return q ? [] : [...this.running.values()].sort((a, b) => a.start - b.start);
  }

  getTreeItem(q: RunningQuery): vscode.TreeItem {
    const secs = Math.floor((Date.now() - q.start) / 1000);
    return Object.assign(new vscode.TreeItem(firstLine(q.sql)), {
      description: `${q.cancelling ? 'Cancelling… · ' : ''}${where(q.conn, q.db)} · ${secs}s`,
      tooltip: new vscode.MarkdownString().appendCodeblock(q.sql, 'sql'),
      iconPath: new vscode.ThemeIcon('loading~spin', q.cancelling ? new vscode.ThemeColor('errorForeground') : undefined),
      contextValue: q.cancelling ? 'cancelling' : 'running',
    });
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** Sidebar "Query History": MAX_HISTORY query terakhir di globalState, terbaru di atas. */
export class History implements vscode.TreeDataProvider<HistoryEntry> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private state: vscode.Memento) {}

  list(): HistoryEntry[] {
    return this.state.get<HistoryEntry[]>(HISTORY, []);
  }

  async add(e: HistoryEntry): Promise<void> {
    await this.state.update(HISTORY, [e, ...this.list()].slice(0, MAX_HISTORY));
    this.changed.fire();
  }

  async remove(e: HistoryEntry): Promise<void> {
    await this.state.update(HISTORY, this.list().filter((x) => x.at !== e.at || x.sql !== e.sql));
    this.changed.fire();
  }

  async clear(): Promise<void> {
    await this.state.update(HISTORY, []);
    this.changed.fire();
  }

  getChildren(e?: HistoryEntry): HistoryEntry[] {
    return e ? [] : this.list();
  }

  getTreeItem(e: HistoryEntry): vscode.TreeItem {
    const icon = { ok: 'pass', error: 'error', cancelled: 'circle-slash' }[e.status];
    const color = { ok: 'testing.iconPassed', error: 'errorForeground', cancelled: 'disabledForeground' }[e.status];
    const time = new Date(e.at).toLocaleString();
    return Object.assign(new vscode.TreeItem(firstLine(e.sql)), {
      description: `${where(e.conn, e.db)} · ${time} · ${e.durationMs} ms`,
      tooltip: new vscode.MarkdownString(`**${e.status}** · ${where(e.conn, e.db)} · ${time} · ${e.durationMs} ms${e.message ? `\n\n${e.message}` : ''}`)
        .appendCodeblock(e.sql, 'sql'),
      iconPath: new vscode.ThemeIcon(icon, new vscode.ThemeColor(color)),
      contextValue: 'history',
      command: { command: 'moonageDaydream.openHistory', title: 'Open', arguments: [e] },
    });
  }
}
