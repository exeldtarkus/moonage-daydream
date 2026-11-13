import { esc } from './resultsHtml';
import { webviewPage } from './webviewPage';

export type ReleaseItem = { kind: 'new' | 'improved' | 'fixed'; title: string; detail?: string };
export type Release = { version: string; date: string; items: ReleaseItem[] };

/** catatan rilis untuk halaman What's New, terbaru di atas; tambah entri baru setiap rilis yang membawa fitur */
export const RELEASES: Release[] = [
  {
    version: '1.3.0', date: '2026-11-13', items: [
      { kind: 'improved', title: 'WHERE is an icon now', detail: 'The WHERE filter no longer takes a row of its own: it is an icon in the result toolbar that opens the input when you click it, like the search icon. A filter that is already applied keeps the field open and the icon lit. WHERE and Search Output take turns: opening one closes the other, so the toolbar never splits in two.' },
      { kind: 'fixed', title: 'Side panels follow the result you are looking at', detail: 'With several queries in one run, Columns, Inspector and Export now work on the grid you clicked, and a picker at the top of the panel lists every result (Query 2 · Result 1 …) so you can switch without scrolling. Export of a selection from the second query works again.' },
      { kind: 'improved', title: 'A friendlier empty results panel', detail: 'Before the first query the panel shows a centered card with a database glyph, a short line about what will appear here and the three shortcuts you need most, instead of a line of grey text in the corner.' },
      { kind: 'improved', title: 'Toolbar sits on the grid', detail: 'The result toolbar is now the top strip of the grid itself: same box, same borders, and it is split into segments (icons, WHERE, Search Output) by full-height lines, and the first line continues the row-number column of the grid below, so the whole header reads as one table, with a line of its own between the icons and the column headers.' },
      { kind: 'new', title: 'Icon toolbar on every result', detail: 'Each result now has one header row: the row count, a search icon and the grid actions (Add row, Delete rows, Save, Generate UPDATE script, Discard) as icons. Search Output stays out of the way until you open it with the icon or Ctrl+F, and closing it clears the search keys.' },
      { kind: 'fixed', title: 'Add row jumps to the new row', detail: 'Clicking + scrolls the new row into view and puts the cursor in the first column you can fill, skipping generated and identity columns. Clicking Delete rows without a selection now says which step is missing instead of doing nothing, and Esc discards every pending change in one go (it still only cancels the cell you are typing in while a cell editor is open).' },
      { kind: 'improved', title: 'Compact result toolbar', detail: 'The WHERE box is slimmer and the result title now shares one row with Search Output, so a result takes one short toolbar row instead of three and more rows of data fit on screen. The row count lives in the footer; the Result N marker only appears when a query returns more than one result set.' },
      { kind: 'new', title: 'Collapse a query in a multi-query result', detail: 'When several statements run at once, every Query section has a chevron: click the title to fold its result away and keep the ones you are analysing in view. All of them start expanded, and Collapse all in the title bar folds or opens every query at once.' },
      { kind: 'improved', title: 'Export moved to the side rail', detail: 'Export is now a panel next to Columns and Inspector on the right edge of the result view: pick the rows and the format, then Save to a file or Copy to the clipboard. The three tabs share one tidy rail.' },
      { kind: 'new', title: 'Double-click selects the whole statement', detail: 'Double-clicking inside a statement in a SQL file selects it completely, up to its ;, instead of a single word. Turn it off with moonageDaydream.editor.doubleClickSelectsStatement.' },
    ],
  },
  {
    version: '1.2.6', date: '2026-11-11', items: [
      { kind: 'new', title: 'Cell value popup', detail: 'Hover (or double-click) a cell in the result grid to see the whole value in a popup, with a Copy button for the raw value; JSON is pretty-printed and colored. Short plain values stay as they are.' },
      { kind: 'fixed', title: 'Selected rows are visible again', detail: 'The selected row is tinted with the editor focus color instead of list.activeSelectionBackground, which some themes set to the same color as the grid background.' },
      { kind: 'improved', title: 'Long values keep their column narrow', detail: 'A long value (JSON, long text) is cut off with an ellipsis instead of stretching its column over the whole grid; the full value is in the popup and the Inspector.' },
    ],
  },
  {
    version: '1.2.5', date: '2026-11-10', items: [
      { kind: 'improved', title: 'Loading indicators', detail: 'The Columns editor, Database Info, Live Monitor, Consul Dashboard, Add Data and New Database show a spinner while their data is being read instead of an empty page.' },
    ],
  },
  {
    version: '1.2.2', date: '2026-11-10', items: [
      { kind: 'new', title: 'Copy from the Columns editor', detail: 'The Copy button offers Copy as script (the CREATE TABLE script of the table) and Copy as JSON (every column with its type, nullability, default, PK / AI / UQ / FK and the other column details, plus the table keys).' },
      { kind: 'new', title: 'Open Table Columns from a SQL file', detail: 'Ctrl+click a table name in a SQL file (FROM / JOIN / UPDATE / INSERT / DELETE, with or without [database].[schema]), or right-click it and choose Open Table Columns, to open its Columns editor on the file\'s connection.' },
      { kind: 'fixed', title: 'Pinned files stay in Open', detail: 'A file pinned in the Open view is no longer dropped when its editor tab is closed; it stays at the top (click to open it again) until you unpin it.' },
      { kind: 'fixed', title: 'Format Document keeps your place', detail: 'Shift+Alt+F on a long SQL file no longer jumps to the last (empty) line; only the changed text is replaced, so the cursor and scroll position stay where they were.' },
    ],
  },
  {
    version: '1.2.1', date: '2026-11-03', items: [
      { kind: 'new', title: 'Load all for very large results', detail: 'Load all reads a result of up to millions of rows into a cache on disk instead of memory; the grid pages through it, with host-side search, column filters and sorting, Search Output chips, export from the cache and Clear Result Cache.' },
      { kind: 'improved', title: 'Row counts with dots', detail: 'Row counts in the result panel use dots as thousands separator (1.000.000 row(s)).' },
    ],
  },
  {
    version: '1.2.0', date: '2026-11-03', items: [
      { kind: 'new', title: 'Find Object (Ctrl+Alt+O)', detail: 'Search connections, databases, tables, views and procedures of every connection at once from a local metadata cache; pick one to run Select Top 100, open its definition or start a query, and it is revealed in Connections. Command Palette: Update Metadata reads connections again one at a time with progress, Clear Cache removes the cache.' },
      { kind: 'new', title: 'Filter in Connections (Ctrl+Alt+F)', detail: 'The funnel on a connection, database or folder shows only names that contain your text.' },
      { kind: 'new', title: 'Open view', detail: 'Every open SQL tab, saved or not: New File, Save All, Close All, close per item, pin to the top and reorder by drag and drop. Clicking a file reveals it in SQL Files.' },
      { kind: 'new', title: 'SQL syntax check', detail: 'SELECT / INSERT / UPDATE / DELETE / WITH statements are checked offline with the dialect of the file\'s connection and marked as a warning (setting moonageDaydream.lint.syntax).' },
      { kind: 'new', title: 'Running queries and history in the status bar', detail: 'A popup shows a running query with Cancel and closes when it finishes; "N running" and "History" sit in the status bar and open quick picks to cancel, reopen, run again or copy.' },
      { kind: 'new', title: 'Group environment icons', detail: 'Production, UAT, Development and Local Development groups get their own icon and color, guessed from the name or set by right-click.' },
      { kind: 'improved', title: 'Connection rows', detail: 'The database logo stays visible with a pulsing dot while connected, groups show how many are connected, the tooltip lists host, user, database and group, and expanding a disconnected connection shows a loading bar until it is connected.' },
      { kind: 'improved', title: 'One preview tab', detail: 'Clicking tables and history entries reuses one SQL tab until you edit it.' },
      { kind: 'improved', title: 'Faster large results', detail: 'The result grid draws only the rows near the viewport.' },
      { kind: 'fixed', title: 'Slow or failed connections', detail: 'A slow connection no longer freezes the rest of Connections, and a connection that failed is no longer shown as connected.' },
    ],
  },
  {
    version: '1.1.0', date: '2026-11-02', items: [
      { kind: 'improved', title: 'Feedback after saving data', detail: 'A notification confirms an Add Data insert or a grid save; Add Data clears its form for the next row.' },
      { kind: 'fixed', title: 'Results panel and forms', detail: 'Opening a form (Columns, New Table, Add Data, ...) closes the Results panel so the form gets the space.' },
    ],
  },
  {
    version: '1.0.0', date: '2026-11-02', items: [
      { kind: 'new', title: 'Multi-column UNIQUE and FOREIGN KEY', detail: 'A Keys table under New Table and the Columns editor adds, changes and drops keys over several columns, with the target table, columns and ON DELETE / ON UPDATE for foreign keys.' },
      { kind: 'new', title: 'MongoDB replica set connections', detail: 'Connection strings with several hosts (mongodb://h1,h2/...) are accepted.' },
      { kind: 'improved', title: 'Errors with Show Log', detail: 'Every error notification has a Show Log button; the "Moonage Daydream" output logs the context and stack trace.' },
      { kind: 'improved', title: 'Faster, lighter export', detail: 'Export streams rows straight to the file on MySQL / MariaDB, PostgreSQL and SQLite instead of loading the whole result first.' },
      { kind: 'improved', title: 'Faster result grid', detail: 'Table metadata used to decide whether rows can be edited is reused for 60 seconds.' },
      { kind: 'fixed', title: 'GO in SQL Server scripts', detail: 'GO inside a string or comment no longer splits a batch, and GO n runs the batch n times.' },
    ],
  },
  {
    version: '0.7.0', date: '2026-11-02', items: [
      { kind: 'new', title: 'Columns editor for every database', detail: 'MySQL / MariaDB, PostgreSQL, SQLite and MongoDB join SQL Server: add, rename, change and drop columns, toggle PK / AI / UQ / FK chips, and reorder columns on MySQL / MariaDB.' },
      { kind: 'new', title: 'New Database and New Table', detail: 'Right-click a connection or the Tables folder: a form with a live script for every database (MongoDB creates a collection, SQLite a new file).' },
      { kind: 'new', title: 'Drop Database and Drop Table', detail: 'Right-click a database or table; a confirmation names exactly what will be dropped.' },
      { kind: 'new', title: 'Add Data', detail: 'Right-click a table → Add Data…: one field per column, a live INSERT script and a confirmation before it runs.' },
      { kind: 'new', title: 'Edit rows in the result grid', detail: 'Add, delete and edit rows, review the statements, then save them in one transaction (MongoDB: document by document). Results that cannot be edited show why.' },
      { kind: 'new', title: 'Click a table to see its data', detail: 'Left-click a table, view or collection in the Explorer to run Select Top 100.' },
      { kind: 'new', title: 'Database Info dashboard (SQL Server)', detail: 'State, recovery model, collation, object counts, file sizes with usage bars and the last backup, each with its query.' },
      { kind: 'new', title: 'New Linked Server (SQL Server)', detail: 'Create a linked server from a form; the remote password never appears in the script and the connection is tested right after.' },
      { kind: 'new', title: 'New object templates', detail: '(+) on Explorer folders opens a ready-to-edit script for views, procedures, functions, triggers, types and sequences (right-click a table → New Trigger… on MySQL / MariaDB, PostgreSQL and SQLite).' },
      { kind: 'new', title: "What's New", detail: 'This page: it opens once after an update with new features.' },
      { kind: 'fixed', title: 'Connection form search', detail: 'Searching database types splits on spaces again instead of the letter "s".' },
      { kind: 'fixed', title: 'Foreign keys to another schema', detail: 'The MySQL / MariaDB Columns editor now shows foreign keys that point to a table in another database.' },
      { kind: 'fixed', title: 'Identity columns in new tables', detail: 'Identity / auto-increment columns are always NOT NULL.' },
    ],
  },
  {
    version: '0.6.5', date: '2026-10-30', items: [
      { kind: 'improved', title: 'Automatic releases', detail: 'New versions are published to the VS Code Marketplace and Open VSX from GitHub Actions, with a GitHub Release and .vsix for every tag.' },
    ],
  },
  {
    version: '0.6.4', date: '2026-10-30', items: [
      { kind: 'new', title: 'Columns editor for SQL Server tables', detail: 'Right-click a table → Columns: add, rename, change type / null / default and drop columns, review the script, then execute.' },
    ],
  },
  {
    version: '0.6.3', date: '2026-10-30', items: [
      { kind: 'new', title: 'Consul dashboard split view', detail: 'Browse keys on the left and edit values on the right, with a cluster summary on top.' },
      { kind: 'fixed', title: 'Consul key filter', detail: 'The filter is cleared when you move to another folder.' },
    ],
  },
  {
    version: '0.6.2', date: '2026-10-29', items: [
      { kind: 'fixed', title: 'Disconnect', detail: 'Disconnected connections no longer reconnect or show a stale status.' },
    ],
  },
  {
    version: '0.6.0', date: '2026-10-29', items: [
      { kind: 'new', title: 'Consul connections', detail: 'Browse and edit the KV store (with confirmation and conflict check) and open a Consul dashboard.' },
      { kind: 'new', title: 'Connect / Disconnect', detail: 'Connect or disconnect each connection from the Explorer, with a connected status and an idle auto-disconnect setting.' },
    ],
  },
  {
    version: '0.5.0', date: '2026-10-29', items: [
      { kind: 'new', title: 'Live Monitor', detail: 'Live charts and tables for SQL Server, MySQL / MariaDB (with a Blocking tab) and PostgreSQL.' },
      { kind: 'new', title: 'SQL Server Object Explorer', detail: 'Tables, views, procedures, functions and more, grouped like the mssql extension.' },
      { kind: 'new', title: 'Procedures, functions and views', detail: 'Show Definition, Edit (CREATE OR ALTER) and Run with parameters from the Explorer.' },
      { kind: 'new', title: 'Confirm data changes in Auto-commit', detail: 'Statements that change data ask for confirmation before they run.' },
      { kind: 'improved', title: 'Transaction state', detail: 'MySQL / MariaDB and PostgreSQL read the open transaction state from the server.' },
    ],
  },
  {
    version: '0.4.0', date: '2026-10-29', items: [
      { kind: 'new', title: 'Connection form sections', detail: 'Connection, SSL/TLS, Timeouts, Permissions (read-only) and Driver settings.' },
      { kind: 'new', title: 'Import connections', detail: 'Paste a connection string or import your DBCode connections.' },
      { kind: 'improved', title: 'Statement results', detail: 'Each statement shows its own result or affected row count.' },
      { kind: 'fixed', title: 'SQL Server manual transactions', detail: 'The transaction state is read from @@TRANCOUNT.' },
    ],
  },
  {
    version: '0.3.0', date: '2026-10-29', items: [
      { kind: 'new', title: 'MySQL / MariaDB, PostgreSQL, SQLite and MongoDB', detail: 'All databases in one Explorer, with MongoDB autocomplete.' },
      { kind: 'new', title: 'Connection groups and colors', detail: '15 colors, groups such as prod / non-prod, Rename / Change Color / Delete, and a two-step connection form.' },
      { kind: 'new', title: 'SQL Files', detail: 'Drag & drop, rename, duplicate, delete and reveal SQL files.' },
      { kind: 'new', title: 'Result grid', detail: 'Filter, sort, reorder columns, edit cells into an UPDATE script, pin results, Load more and export to xlsx / csv / json / markdown / html.' },
      { kind: 'new', title: 'Execution plans and manual transactions', detail: 'Execute | Explain | Analyze per statement, and Commit / Rollback per file.' },
    ],
  },
];

/** buka otomatis selama catatan rilis terbaru belum pernah dilihat (seen = versi terakhir yang dibuka user) */
export function shouldShow(seen: string | undefined, releases: Release[]): boolean {
  return releases.length > 0 && seen !== releases[0].version;
}

const KIND = { new: 'New', improved: 'Improved', fixed: 'Fixed' };

function releaseHtml(r: Release, latest: boolean): string {
  const count = (['new', 'improved', 'fixed'] as const)
    .map((k) => [k, r.items.filter((i) => i.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `<span class="count ${k}">${n} ${KIND[k].toLowerCase()}</span>`).join('');
  const items = r.items.map((i) => `<li><span class="kind ${i.kind}">${KIND[i.kind]}</span><div><strong>${esc(i.title)}</strong>${i.detail ? `<p>${esc(i.detail)}</p>` : ''}</div></li>`).join('');
  return `<details${latest ? ' open' : ''} class="release">
<summary><span class="ver">v${esc(r.version)}</span>${latest ? '<span class="latest">Latest</span>' : ''}<time>${esc(r.date)}</time><span class="counts">${count}</span></summary>
<ul>${items}</ul>
</details>`;
}

/** halaman What's New (statis, tanpa script) */
export function whatsNewHtml(cspSource: string, installed: string, releases: Release[] = RELEASES): string {
  return webviewPage('whatsNew', {
    cspSource,
    installed: esc(installed),
    releases: releases.map((r, i) => releaseHtml(r, i === 0)).join('\n'),
  });
}
