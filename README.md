# Moonage Daydream

English | [Bahasa Indonesia](README.id.md)

A VS Code database client for SQL Server, MySQL / MariaDB, PostgreSQL, SQLite and MongoDB. Write queries in `.sql` files, run them with a shortcut or CodeLens, and view, filter, edit and export the results in a grid.

![Results grid with column type tags, selected rows, WHERE toolbar and Load more](images/screenshots/results.png)

## Features

- **Five database types**:
  - **SQL Server**: SQL login or Windows authentication (NTLM with domain), named instances via SQL Server Browser, optional *trust server certificate*, `GO` batch separators.
  - **MySQL / MariaDB** (mysql2) and **PostgreSQL** (pg).
  - **SQLite** (sql.js, WebAssembly): the database file is read for each query and written back after statements that change data.
  - **MongoDB**: mongosh-style queries such as `db.users.find({ age: { $gt: 30 } }).sort({ name: 1 }).limit(10);`, plus `aggregate`, `countDocuments`, `distinct`, insert / update / delete, `db.getCollection(...)` and `db.runCommand(...)`. Documents are shown as grid columns. The host may be a `mongodb://` or `mongodb+srv://` connection string.
- **Connections view**: connection → database → Tables / Views / Procedures → columns, with a logo per database type. **Select Top 100** on a table or view, **New SQL File** on a database. Passwords are stored in VS Code SecretStorage.
- **Connection groups and colors**: put connections in group folders (e.g. `prod`, `non-prod`) and give them a color; a colored connection is also marked in the `.sql` editor, which helps to recognize production connections.
- **Connection and database per file**, shown and changed via CodeLens at the top of the file.
- **Run**: the selection, or the statement under the cursor. CodeLens per statement: **Execute**, **Explain**, **Analyze** (SELECT only). Several SELECTs selected together run in parallel. Running queries can be cancelled on the server.
- **Auto limit** for a single SELECT, then **Load more (+1000)** up to 50,000 rows in the grid.
- **Manual transaction mode** per file with **Commit** / **Rollback** lenses.
- **Results grid**: column type tags, a WHERE toolbar that re-runs the query on the server, per-column filter / sort / hide on the loaded rows, column reorder, **Columns** / **Inspector** side panels, row selection with Ctrl+C (copied as TSV), virtual scrolling for large results.
- **Export** all data or the selected rows to CSV, TSV, JSON, JSON (pretty), Markdown, HTML or Excel (.xlsx), or copy to the clipboard.
- **Pin results** to keep them in their own tab, side by side.
- **Edit cells**: edits generate an UPDATE script by primary key in a new tab. The script is never executed automatically.
- **Execution plans**: graphical plan with cost bars for SQL Server; the `EXPLAIN` output as a grid for the other databases.
- **Editor support**: autocomplete (databases, schemas, tables, columns including aliases, keywords and functions; for MongoDB collections, methods, field names and `$` operators), a formatter (dialect follows the connection), a lint for statements without `;` with a Quick Fix.
- **Side views**: **SQL Files** (folders or a flat list, with rename, duplicate, delete and drag & drop), **Running Queries**, **Query History**.

## Installation

From source:

```bash
npm install
npm run install:local   # builds the VSIX and installs it if the version changed (add -- --force to reinstall)
```

Then run **Developer: Reload Window**.

Or build the package and install it manually:

```bash
npm run package
code --install-extension moonage-daydream-<version>.vsix
```

## Usage

### 1. Add a connection

Open the **Moonage Daydream** view in the Activity Bar and click **+** (**Add Connection**) in the **Connections** view. A new connection takes two steps:

1. **Choose the database**: under a **New connection** header, a card in the brand color of each database, with a logo, for SQL Server, MySQL, MariaDB, PostgreSQL, SQLite and MongoDB. The cards appear with a short animation and show **Connect →** on hover (the motion is reduced when the OS asks for reduced motion). The card sets the default port and an example username for that type.
2. **Fill in the form** for that type. **Change database** (top right) goes back to step 1.

![Step 1 of a new connection: the New connection header and brand-colored cards for SQL Server, MySQL, MariaDB, PostgreSQL, SQLite and MongoDB, each with a logo and a short description; the hovered PostgreSQL card shows Connect →](images/screenshots/new-connection.png)

The form is split into sections:

- **Connection**: name, **Group** and **Color** (see below);
- **Server**: host and port; for SQL Server also the instance name (the port is then resolved by SQL Server Browser). For MongoDB the host may be a full `mongodb://` or `mongodb+srv://` connection string. For SQLite this section only has the path of the database file;
- **Authentication**: username and password (the eye icon shows or hides it); for SQL Server the method *SQL login* or *Windows (NTLM)* with a domain; for MongoDB the auth database;
- **Options**: the default database (optional); for SQL Server *trust server certificate*.

**Test connection** checks the connection before **Save connection**; the result is shown in the footer next to the buttons. **Edit Connection** opens the form (step 2) directly.

![Editing the PostgreSQL connection shop-pg: sections Connection (Group prod, Color red selected among 15 color swatches), Server, Authentication (password field with an eye icon) and Options, with Test connection, Cancel and Save connection at the bottom](images/screenshots/connection.png)

**Group** puts the connection in a folder in **Connections**: choose *No group*, an existing group, or *New group…* to type a new name. Each group folder shows the number of connections in it; **+** (**Add Connection**) on a group folder preselects that group. Right-click a group folder for **Rename Group…**. In the connection quick pick the group is shown as `[group]`.

**Color** (a swatch: None or one of 15 colors: Red, Coral, Orange, Yellow, Gold, Lime, Green, Teal, Cyan, Sky, Blue, Purple, Magenta, Pink, Gray) marks the connection. The colors come from the VS Code theme (`charts.*` and `terminal.ansi*`), so they follow light and dark themes:

- in **Connections** the connection name is shown in that color with a ● badge;
- in a `.sql` editor bound to the connection, a colored bar runs along the left of all lines, and the label `you are using connection <group> - <name>` (without a group: `you are using connection <name>`) is shown at the end of the top visible line, so it stays visible while scrolling.

Use for example Red for production connections.

Right-click a connection in **Connections** for:

- **Select Connection**: make it the active connection;
- **Edit Connection…** (also the pencil button on the connection row): open the form;
- **Rename…**: a new, unique name; the saved password and the `.sql` files bound to the connection follow the new name;
- **Change Color…**: a quick pick with colored circles, or *No color*;
- **Move to Group…**;
- **Delete Connection**: asks to confirm; the saved password is removed too, and files bound to it fall back to the active connection.

Expand a connection to browse databases, tables, views, procedures and columns. Use the play icon on a table or view for **Select Top 100**, or the new-file icon on a database for **New SQL File** bound to that database.

### 2. Run queries

Open or create a `.sql` file. The CodeLens at the top shows the connection and database of the file; click them to change. Then:

- **Ctrl+Alt+Enter** runs the selection, or the statement under the cursor. **Ctrl+Enter** does the same when the DBCode extension is not installed.
- Each statement has **Execute**, **Explain** and (for SELECT) **Analyze** lenses.
- While a query runs, a **Cancel** lens appears; the query is cancelled on the server.

```sql
SELECT order_id, customer, city, status, total
FROM sales.orders
WHERE status = 'paid';
```

A single SELECT without its own limit fetches only the first `moonageDaydream.query.autoLimit` rows (default 100). **Load more (+1000)** fetches the next page, up to 50,000 rows in the grid.

Select several SELECT statements and run them together: they run in parallel and each result appears as soon as it is done.

![Two queries running in parallel, one finished and one still running](images/screenshots/parallel.png)

### 3. Filter and sort

Type a condition in the **WHERE** box and press Enter: the query runs again on the server with that condition. The filter icon in a column header filters the loaded rows by text; the column menu sorts or hides the column. Reorder and show / hide columns by dragging and ticking them in the **Columns** side panel.

![WHERE status = 'paid' plus a column filter on city](images/screenshots/filter.png)

Click a row to select it (Ctrl / Shift for more rows); Ctrl+C copies the selection as TSV. The **Inspector** side panel shows every column of the selected row with its type; **Columns** lists the columns with their types.

![Inspector side panel showing one row with column types](images/screenshots/inspector.png)

### 4. Export

Click **Export**, choose **All Data** or the selection and a format (Excel .xlsx, CSV, TSV, JSON, JSON pretty, Markdown, HTML), then **Save** to a file or **Copy** to the clipboard.

![Export popup with All Data and Excel (.xlsx)](images/screenshots/export.png)

**Pin** keeps the current results in their own tab so the next query does not replace them.

### 5. Edit cells

Double-click a cell in the first result to edit it. Edited cells are counted in the footer; **Generate UPDATE script** opens an UPDATE script keyed on the primary key in a new tab, **Discard** drops the edits. Review the script and run it yourself; it is never executed automatically.

### 6. Explain and Analyze

**Explain** shows the estimated plan without running the statement. **Analyze** runs the SELECT and shows the actual plan (on SQL Server inside a transaction that is rolled back). For SQL Server the plan is shown as an operator tree with cost bars (**Open XML** opens the raw plan); for the other databases the `EXPLAIN` output is shown as a grid.

![Analyze plan for SQL Server with estimated and actual rows and cost bars](images/screenshots/plan.png)

### 7. Transactions

By default every statement auto-commits. Switch a file to manual mode with **Toggle Transaction Mode** (or the CodeLens / status bar): statements then run in an open transaction until you click **Commit** or **Rollback**. The default for new files is set by `moonageDaydream.transaction.mode`.

### 8. Autocomplete, formatter and lint

**Format SQL** (Ctrl+Alt+F, or Format Document) uses the SQL dialect of the file's connection. Keyword case, leading commas and the semicolon on its own line are configurable. Statements without a terminating `;` are marked, with a Quick Fix to add it.

For MongoDB connections autocomplete follows the shell syntax:

- after `db.`: collection names and db methods (`getCollection`, `runCommand`, `stats`, …);
- inside `db.getCollection("`: collection names;
- after `db.orders.` or `db.getCollection("orders").`: collection methods (`find`, `findOne`, `aggregate`, `countDocuments`, `updateOne`, `deleteMany`, …), inserted as snippets;
- after `).`: cursor methods (`sort`, `limit`, `skip`, `project`, `hint`, `explain`, …);
- inside the `{ }` of a `find`, `sort` and so on: field names (sampled from one document of the collection) and `$` operators.

### 9. Views

- **SQL Files**: all `.sql` files in the workspace, as folders (default) or a flat list; the choice is remembered. **New SQL File** on a folder. Right-click a file or folder for **Rename…** (F2), **Duplicate…**, **Delete** (Delete key), **Copy Path**, **Copy Relative Path**, **Open to the Side** and **Reveal in Explorer View**. **Delete** moves the item to the Recycle Bin / Trash; in a remote window (WSL, SSH) there is no Trash, so it asks to confirm a permanent delete. Drag files or folders onto a folder to move them; drag a file to the editor to open it (drop on an editor edge to open it in a split). The connection and database bound to a file follow a rename or move, and are copied by **Duplicate**.
- **Running Queries**: running queries with elapsed time, cancel one or all.
- **Query History**: run again, copy the SQL, open in an editor, remove, clear.

**Move Results To…** (Results view title) puts the results in the bottom panel, or to the right or left of the editor.

Errors are written to the **Moonage Daydream** output channel (**View → Output**).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `moonageDaydream.query.autoLimit` | `100` | Auto limit for a single SELECT without TOP / OFFSET FETCH / INTO. `0` = off |
| `moonageDaydream.transaction.mode` | `auto` | Default transaction mode for SQL files: `auto` or `manual` |
| `moonageDaydream.format.keywordCase` | `upper` | Keyword case when formatting: `upper`, `lower`, `preserve` |
| `moonageDaydream.format.leadingComma` | `true` | Put commas at the start of the line (`    , column`) |
| `moonageDaydream.format.semicolonNewline` | `true` | Put the semicolon that ends a statement on its own line |
| `moonageDaydream.lint.semicolon` | `error` | Mark statements not terminated with `;`: `error`, `warning`, `off` |

The extension also sets itself as the default formatter for `[sql]`.

## Keybindings

| Key | Command |
| --- | --- |
| Ctrl+Alt+Enter (Cmd+Alt+Enter) | Run Query (selection or statement under the cursor) |
| Ctrl+Enter (Cmd+Enter) | Run Query, only when the DBCode extension is not installed |
| Ctrl+Alt+F (Cmd+Alt+F) | Format SQL |
| Shift+Alt+F | Format SQL, when Moonage Daydream is the SQL formatter |
| F2 (Enter) | Rename… in the SQL Files view |
| Delete (Cmd+Backspace) | Delete in the SQL Files view |

## Commands

| Command | Description |
| --- | --- |
| `Moonage Daydream: Add Connection` / `Edit Connection…` / `Delete Connection` | Manage connections |
| `Moonage Daydream: Rename…` / `Change Color…` | Rename a connection or change its color (Connections view) |
| `Moonage Daydream: Select Connection` | Choose the active connection |
| `Moonage Daydream: Move to Group…` / `Rename Group…` | Connection groups (Connections view) |
| `Moonage Daydream: Change Connection for This File` / `Change Database for This File` | Per-file connection and database |
| `Moonage Daydream: Run Query (selection or statement at cursor)` | Run the selection or the statement under the cursor |
| `Moonage Daydream: Explain (estimated plan)` / `Analyze (actual plan, SELECT only)` | Execution plans |
| `Moonage Daydream: Cancel Query` / `Cancel All Running Queries` | Cancel on the server |
| `Moonage Daydream: Toggle Transaction Mode (Auto-commit / Manual)` | Switch the file's transaction mode |
| `Moonage Daydream: Commit Transaction` / `Rollback Transaction` | End a manual transaction |
| `Moonage Daydream: Pin Results (keep in its own tab, side by side)` | Pin the current results |
| `Moonage Daydream: Move Results To…` | Panel, right or left of the editor |
| `Moonage Daydream: Format SQL (Moonage)` | Format the document or selection |
| `Moonage Daydream: New SQL File` | Create a `.sql` file |
| `Moonage Daydream: Rename…` / `Duplicate…` / `Delete` | Manage a file or folder (SQL Files view) |
| `Moonage Daydream: Copy Path` / `Copy Relative Path` / `Open to the Side` / `Reveal in Explorer View` | SQL Files view |
| `Moonage Daydream: Show SQL Files as List` / `Show SQL Files as Folders` | SQL Files view layout |
| `Moonage Daydream: Clear History` | Clear the query history |

## Limitations

- SQLite: the whole database file is read for each query, and a running query cannot be cancelled.
- MongoDB: no manual transactions and no formatter.
- The grid holds at most 50,000 rows (Load more stops there); use Export for all data.
- SQLite has no Analyze (only `EXPLAIN QUERY PLAN`).

## Development

```bash
npm install
npm run compile          # TypeScript -> out/
npm test                 # compile + unit tests (node --test)
npm run test:servers     # integration tests against MySQL 8.4, MariaDB 11.4, PostgreSQL 16, MongoDB 7 in Docker
npm run test:servers-ui  # same Docker containers, tested in the Extension Development Host
npm run test:real        # Extension Development Host against an existing SQL Server connection (SELECT only)
npm run package          # build the .vsix (vsce)
npm run install:local    # build + install into your local VS Code (add -- --force to reinstall the same version)
node scripts/screenshots.js   # regenerate the README images (after npm run compile)
```

`npm run test:servers` needs Docker. It starts the containers, runs `src/test/servers.itest.ts`, then removes the containers and images; set `KEEP_IMAGES=1` to keep the images for the next run.

`npm run test:servers-ui` starts the same Docker containers (MySQL, MariaDB, PostgreSQL, MongoDB) and runs a test in the Extension Development Host (`scripts/real-test.sh servers`, `serversUiTest` in `src/test/real/index.ts`). It adds temporary connections named `__moonage_it_*` to your VS Code profile (plus a temporary SQLite file), exercises run / CodeLens / Load more / export / UPDATE script / Explain / manual transaction / explorer / completion / format, then removes the temporary connections and their passwords and restores the connection list exactly (a backup of the list, without passwords, is written to `docs/main/backup/`). Containers and images are removed afterwards unless `KEEP_IMAGES=1`.

`npm run test:real` and `npm run test:servers-ui` open an Extension Development Host and start the test by writing a trigger file (`docs/main/temp/real-test.trigger`) that the development window watches. Only if no report appears after about 30 seconds do they open the `vscode://` URI with `powershell.exe` as a fallback, so they also work from WSL with VS Code on Windows.

`scripts/real-test.sh <name>` runs one test group: `files` (SQL Files view), `groups` (connection groups), `servers` (the `test:servers-ui` test, needs its containers) or `big` (large result and cancel); without a name the full `test:real` suite runs.

## License

MIT, see [LICENSE](LICENSE).

### Credits

Database logos in the Connections view (`media/db/*.svg`) are from [devicon](https://github.com/devicons/devicon) 2.18.0 (MIT License). The logos are trademarks of their owners and are used only to identify the database type of a connection; see [media/db/NOTICE.md](media/db/NOTICE.md).
