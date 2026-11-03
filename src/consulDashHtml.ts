import { randomBytes } from 'crypto';
import { esc } from './resultsHtml';
import { webviewPage } from './webviewPage';

/** panel Consul Dashboard: ringkasan cluster (leader / services / checks / nodes / members) + 2-kolom KV (kiri: keys & folders, kanan: value editor) */
export function consulDashboardHtml(cspSource: string, title: string): string {
  const nonce = randomBytes(16).toString('base64');
  return webviewPage('consulDash', {
    cspSource,
    nonce,
    title: esc(title),
  });
}
