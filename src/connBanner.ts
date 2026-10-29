import * as vscode from 'vscode';
import type { ConnectionInfo } from './db';
import { CONN_COLORS, bannerText, gutterSvg } from './connColor';
import type { ConnColor } from './connColor';

/** warna koneksi -> warna tema (charts.*): terbaca di tema gelap dan terang */
export const themeColor = (c?: ConnColor) => (c ? new vscode.ThemeColor(CONN_COLORS[c]) : undefined);

/**
 * label "you are using connection <group> - <nama>" di akhir baris pertama editor .sql, berwarna sesuai koneksi,
 * plus garis warna di tepi kiri semua baris (koneksi tanpa warna: label abu-abu, tanpa garis).
 */
export class ConnBanner implements vscode.Disposable {
  private badges = new Map<string, vscode.TextEditorDecorationType>();
  private borders = new Map<string, vscode.TextEditorDecorationType>();

  private badge(color?: ConnColor): vscode.TextEditorDecorationType {
    const key = color ?? '';
    let t = this.badges.get(key);
    if (!t) {
      const tc = themeColor(color);
      t = vscode.window.createTextEditorDecorationType({
        after: {
          // kalem: transparan + border tipis, tetap terbaca tanpa menarik perhatian dari query
          margin: '0 0 0 3em', fontStyle: 'italic', color: tc ?? new vscode.ThemeColor('editorCodeLens.foreground'),
          border: '1px solid', borderColor: tc ?? new vscode.ThemeColor('editorCodeLens.foreground'), textDecoration: 'none; border-radius: 10px; padding: 0 8px; opacity: .6; font-size: .9em',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      });
      this.badges.set(key, t);
    }
    return t;
  }

  private border(color: ConnColor): vscode.TextEditorDecorationType {
    let t = this.borders.get(color);
    if (!t) {
      const tc = themeColor(color);
      // garis di gutter (bukan border di samping teks) + penanda di scrollbar
      t = vscode.window.createTextEditorDecorationType({ isWholeLine: true, gutterIconPath: vscode.Uri.parse(gutterSvg(color)), gutterIconSize: 'cover',
        overviewRulerColor: tc, overviewRulerLane: vscode.OverviewRulerLane.Left });
      this.borders.set(color, t);
    }
    return t;
  }

  /** gambar ulang editor .sql yang terlihat (koneksi file bisa berubah, warna koneksi bisa diedit); only = satu editor (scroll) */
  update(fileConn: (uri: vscode.Uri) => ConnectionInfo | undefined, only?: vscode.TextEditor): void {
    for (const ed of only ? [only] : vscode.window.visibleTextEditors) {
      if (ed.document.languageId !== 'sql') continue;
      const c = fileConn(ed.document.uri);
      const color = c?.color;
      const badge = c ? this.badge(color) : undefined;
      for (const t of [...this.badges.values(), ...this.borders.values()]) if (t !== badge && (!color || t !== this.borders.get(color))) ed.setDecorations(t, []);
      if (!c || !badge) continue;
      // baris teratas yang terlihat (bukan baris 0): label tetap kelihatan saat scroll
      const top = ed.visibleRanges[0]?.start.line ?? 0;
      const end = ed.document.lineAt(Math.min(top > 0 ? top + 1 : 0, ed.document.lineCount - 1)).range.end; // +1: baris teratas sering terpotong saat scroll
      ed.setDecorations(badge, [{ range: new vscode.Range(end, end), renderOptions: { after: { contentText: bannerText(c) } } }]);
      if (color) ed.setDecorations(this.border(color), [new vscode.Range(0, 0, ed.document.lineCount - 1, 0)]);
    }
  }

  dispose(): void {
    for (const t of [...this.badges.values(), ...this.borders.values()]) t.dispose();
  }
}
