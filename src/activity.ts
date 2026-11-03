import * as vscode from 'vscode';
import { firstLine, runningStatus } from './runningStatus';

export { firstLine };

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

/** status bar kanan bawah "⟳ N running" selama ada query berjalan (elapsed tiap detik); klik = Quick Pick untuk cancel. */
export class RunningView {
  private timer: NodeJS.Timeout | undefined;
  private bar = vscode.window.createStatusBarItem('moonageDaydream.running', vscode.StatusBarAlignment.Right, 100);

  constructor(readonly running: Map<string, RunningQuery>) {
    this.bar.name = 'Moonage Daydream: Running Queries';
    this.bar.command = 'moonageDaydream.showRunning';
  }

  refresh(): void {
    this.updateBar();
    if (this.running.size && !this.timer) this.timer = setInterval(() => this.updateBar(), 1000);
    if (!this.running.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private updateBar(): void {
    const s = runningStatus([...this.running.values()], Date.now());
    if (!s) { this.bar.hide(); return; }
    this.bar.text = s.text;
    this.bar.tooltip = `${s.tooltip.join('\n')}\n\nClick to cancel a query`;
    this.bar.show();
  }

  /** query berjalan, terlama dulu */
  list(): RunningQuery[] {
    return [...this.running.values()].sort((a, b) => a.start - b.start);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.bar.dispose();
  }
}

/** Query History: MAX_HISTORY query terakhir di globalState, terbaru di atas; status bar kanan bawah "🕘 History" membuka Quick Pick. */
export class History {
  private bar = vscode.window.createStatusBarItem('moonageDaydream.history', vscode.StatusBarAlignment.Right, 99);

  constructor(private state: vscode.Memento) {
    this.bar.name = 'Moonage Daydream: Query History';
    this.bar.text = '$(history) History';
    this.bar.tooltip = 'Query History: open, run again, copy or remove a past query';
    this.bar.command = 'moonageDaydream.showHistory';
    this.bar.show();
  }

  list(): HistoryEntry[] {
    return this.state.get<HistoryEntry[]>(HISTORY, []);
  }

  async add(e: HistoryEntry): Promise<void> {
    await this.state.update(HISTORY, [e, ...this.list()].slice(0, MAX_HISTORY));
  }

  async remove(e: HistoryEntry): Promise<void> {
    await this.state.update(HISTORY, this.list().filter((x) => x.at !== e.at || x.sql !== e.sql));
  }

  async clear(): Promise<void> {
    await this.state.update(HISTORY, []);
  }

  dispose(): void {
    this.bar.dispose();
  }
}
