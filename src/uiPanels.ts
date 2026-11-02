import * as vscode from 'vscode';

/** tutup panel Results bawah sebelum membuka UI Moonage Daydream */
export function closeResultsPanel(): void {
  void vscode.commands.executeCommand('workbench.action.closePanel');
}
