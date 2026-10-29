# Moonage Daydream

English | [Bahasa Indonesia](README.id.md)

A VS Code database client for SQL Server, MySQL / MariaDB, PostgreSQL, SQLite and MongoDB. Write queries in `.sql` files, run them with a shortcut or CodeLens, and view, filter, edit and export the results in a grid.

![Results grid with column type tags, selected rows, WHERE toolbar and Load more](images/screenshots/results.png)

## Features

- **Five database types**:
  - **SQL Server**: SQL login or Windows authentication (NTLM with domain), named instances via SQL Server Browser, SSL / TLS (encrypt) with optional *trust server certificate*, `GO` batch separators.
  - **MySQL / MariaDB** (mysql2) and **PostgreSQL** (pg).
  - **SQLite** (sql.js, WebAssembly): the database file is read for each query and written back after statements that change data.
  - **MongoDB**: mongosh-style queries such as `db.users.find({ age: { $gt: 30 } }).sort({ name: 1 }).limit(10);`, plus `aggregate`, `countDocuments`, `distinct`, insert / update / delete, `db.getCollection(...)` and `db.runCommand(...)`. Documents are shown as grid columns. The host may be a `mongodb://` or `mongodb+srv://` connection string.
- **Connections view**: connection → database → Tables / Views / Procedures → columns, with a logo per database type. **Select Top 100** on a table or view, **New SQL File** on a database. Passwords are stored in VS Code SecretStorage.
- **Views, procedures and functions** (SQL Server, MySQL / MariaDB, PostgreSQL): right-click for **Show Definition**, **Edit** (a `CREATE OR ALTER` / `CREATE OR REPLACE` script) and **Run Procedure…** (an EXEC / CALL / SELECT script with every argument); procedures and functions expand to their parameters.
- **SQL Server Object Explorer** like the mssql extension: Databases / System Databases, Security, Server Objects, SQL Server Agent (jobs with **Start Job** / **Stop Job**); per database Tables, Views, Synonyms, Programmability and Security; per table Columns, Keys, Constraints, Triggers, Indexes and Statistics. **Script as…** CREATE / ALTER / DROP / SELECT / INSERT / UPDATE / DELETE, **Activity Monitor**, **Kill Session…**, **Server Info**, **Database Info**, **Backup / Restore Database (script)…**.
- **Live Monitor (charts)** for SQL Server, MySQL / MariaDB and PostgreSQL: live charts for a whole server or one database, with Running queries, Sessions / Blocking, waits and Expensive queries tabs, and **Kill** with confirmation.
- **Connection form** with a sidebar: **Connection**, **SSL / TLS**, **Timeouts**, **Permissions** (read only) and **Driver settings**, each with a short summary. **Import connection string** fills the form from a SQL Server `Server=...;Database=...` string or a `mysql://`, `mariadb://`, `postgres://` or `mongodb://` URL.
- **Import Connections from DBCode…**: copies the connections from the DBCode setting `dbcode.connections` (without passwords).
- **Connection groups and colors**: put connections in group folders (e.g. `prod`, `non-prod`) and give them a color; a colored connection is also marked in the `.sql` editor, which helps to recognize production connections.
- **Connection and database per file**, shown and changed via CodeLens.
- **Run**: the selection, or the statement under the cursor. CodeLens above every statement: **Execute**, **Explain**, **Analyze** (SELECT only), connection, database and transaction mode. Several SELECTs selected together run in parallel. Running queries can be cancelled on the server.
- **Auto limit** for a single SELECT, then **Load more (+1000)** up to 50,000 rows in the grid.
- **Manual transaction mode** per file with **Commit** / **Rollback** lenses; on SQL Server, MySQL / MariaDB and PostgreSQL the state is read from the server and `COMMIT` / `ROLLBACK` may be part of the script.
- **Auto-commit confirmation**: statements that change data in Auto-commit mode ask first (on by default; can be turned off per group or connection).
- **Results grid**: column type tags, a WHERE toolbar that re-runs the query on the server, per-column filter / sort / hide on the loaded rows, column reorder, **Columns** / **Inspector** side panels, row selection with Ctrl+C (copied as TSV), virtual scrolling for large results. UPDATE / INSERT / DELETE results show their `n row(s) affected` under a **Statement n** title, also next to SELECT results.
- **Export** all data or the selected rows to CSV, TSV, JSON, JSON (pretty), Markdown, HTML or Excel (.xlsx), or copy to the clipboard.
- **Pin results** to keep them in their own tab, side by side.
- **Edit cells**: edits generate an UPDATE script by primary key in a new tab. The script is never executed automatically.
- **Execution plans**: graphical plan with cost bars for SQL Server; the `EXPLAIN` output as a grid for the other databases.
- **Editor support**: autocomplete (databases, schemas, tables, columns including aliases and the target table of UPDATE / INSERT / DELETE, keywords and functions; for MongoDB collections, methods, field names and `$` operators), a formatter (dialect follows the connection), a lint for statements without `;` with a Quick Fix.
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

**Search databases** (top right of step 1) filters the cards.

![Step 1 of a new connection: the New connection header and brand-colored cards for SQL Server, MySQL, MariaDB, PostgreSQL, SQLite and MongoDB, each with a logo and a short description; the hovered PostgreSQL card shows Connect →](images/screenshots/new-connection.png)

The form has a sidebar on the left; each item opens its own section and shows a short summary of its settings (for example *Off*, *Defaults*, *Read & write*, *3 setting(s)*):

- **Connection**:
  - **Connection**: name, **Group** and **Color** (see below);
  - **Server**: host and port; for SQL Server also the instance name (the port is then resolved by SQL Server Browser). For MongoDB the host may be a full `mongodb://` or `mongodb+srv://` connection string. For SQLite this card only has the path of the database file;
  - **Authentication**: username and password (the eye icon shows or hides it); for SQL Server the method *SQL login* or *Windows (NTLM)* with a domain; for MongoDB the auth database;
  - **Database**: the default database (optional).
- **SSL / TLS**: **Enable SSL / TLS** (on by default for SQL Server, where it is *encrypt*; off for the other databases) and **Trust server certificate** (for local or self-signed certificates; off = the certificate is verified), for every driver.
- **Timeouts**: **Connection timeout** in seconds (default 15). Running queries have no timeout (also on SQL Server); stop them with **Cancel**.
- **Permissions**: **Read only**. Only statements that do not change data can run (SELECT / WITH, DECLARE, `SET @var`, SHOW, DESCRIBE; for MongoDB the read methods). UPDATE, INSERT, DELETE, MERGE, `SELECT ... INTO`, DDL and EXEC are blocked before anything is sent to the server, and the results panel shows which statement was blocked.
- **Driver settings**: extra key / value options passed to the driver, for example `appName` (SQL Server), `charset` (MySQL), `application_name` (PostgreSQL), `replicaSet` (MongoDB). The values `true` / `false` and numbers are converted; **+ Add setting** adds a row, **×** removes it.

**Import connection string** (in the **Server** card) opens a box to paste a connection string; **Fill the form** fills host, port, user, password, database, SSL and options, and switches the database type when needed. Nothing is saved until **Save connection**. Supported:

- SQL Server (ADO.NET): `Server=host,1433;Database=shop;User ID=app;Password=...;Encrypt=true;TrustServerCertificate=true`; also `Data Source` / `Initial Catalog`, `host\instance`, and `Integrated Security=SSPI` (Windows authentication);
- URLs: `mysql://`, `mariadb://`, `postgres://` / `postgresql://`, `mongodb://` and `mongodb+srv://`, for example `postgres://app@db.example.com:5432/shop?sslmode=require&application_name=reports`. `ssl`, `tls` and `sslmode` set SSL / TLS, `authSource` sets the MongoDB auth database, and the other query options go to **Driver settings**.

![Editing the PostgreSQL connection shop-pg: the sidebar Connection / SSL / TLS / Timeouts / Permissions / Driver settings with summaries, the Connection section (Group prod, Color red) and the open Import connection string box with a postgres:// URL above Host and Port](images/screenshots/connection.png)

![The Driver settings section with three key / value rows (application_name, statement_timeout, keepAlive) and + Add setting; the sidebar summary shows 3 setting(s)](images/screenshots/connection-driver.png)

**Test connection** checks the connection before **Save connection**; the result is shown in the footer next to the buttons. **Edit Connection** opens the form (step 2) directly.

**Import Connections from DBCode…** (the **⋯** menu of the **Connections** view) reads the connections of the DBCode extension from the setting `dbcode.connections` and shows them in a multi-select quick pick: name, type, host, port, instance, user, database, group, SSL, connection timeout and read only are copied. Connections whose name is already used, or whose type is not supported, are skipped (the message lists them). Passwords are not imported: the password is asked once when the connection is first used, then saved in VS Code Secret Storage.

**Group** puts the connection in a folder in **Connections**: choose *No group*, an existing group, or *New group…* to type a new name. Each group folder shows the number of connections in it; **+** (**Add Connection**) on a group folder preselects that group. Right-click a group folder for **Rename Group…** and **Auto-commit Confirmation…** (see [Transactions](#7-transactions)). In the connection quick pick the group is shown as `[group]`.

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
- **Auto-commit Confirmation…**: *On*, *Off* or *Same as group* (see [Transactions](#7-transactions));
- **Live Monitor (charts)** (SQL Server, MySQL / MariaDB, PostgreSQL): see [Live Monitor](#12-live-monitor);
- **Delete Connection**: asks to confirm; the saved password is removed too, and files bound to it fall back to the active connection.

Expand a connection to browse databases, tables, views, procedures and columns (SQL Server connections show a full Object Explorer, see [SQL Server Object Explorer](#11-sql-server-object-explorer)). Use the play icon on a table or view for **Select Top 100**, or the new-file icon on a database for **New SQL File** bound to that database.

### 2. Run queries

Open or create a `.sql` file. The CodeLens above every statement shows **Execute**, **Explain**, **Analyze** (for SELECT), then the connection, the database and the transaction mode of the file; click the connection or database to change it. Then:

- **Ctrl+Alt+Enter** runs the selection, or the statement under the cursor. **Ctrl+Enter** does the same when the DBCode extension is not installed.
- **Execute** on a lens runs that statement.
- While a query runs, a **Cancel** lens appears; the query is cancelled on the server.

```sql
SELECT order_id, customer, city, status, total
FROM sales.orders
WHERE status = 'paid';
```

A single SELECT without its own limit fetches only the first `moonageDaydream.query.autoLimit` rows (default 100). **Load more (+1000)** fetches the next page, up to 50,000 rows in the grid.

Select several SELECT statements and run them together: they run in parallel and each result appears as soon as it is done.

![Two queries running in parallel, one finished and one still running](images/screenshots/parallel.png)

Statements that do not return rows (UPDATE, INSERT, DELETE, MERGE, `SELECT ... INTO`) show `n row(s) affected` under a **Statement n** title with the SQL of that statement, also when they run together with a SELECT; each result block is separated by a line. When the statement cannot be matched for sure (for example with EXEC), the counts are listed as messages. DDL without any result shows `Commands completed successfully.`

![A SELECT and an UPDATE run together: Result 1 with 5 rows, then a block Statement 2 UPDATE sales.orders SET status = 'shipped' WHERE order_id = 10004; with 1 row(s) affected](images/screenshots/affected.png)

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

**Auto-commit confirmation**: in Auto-commit mode, a run that contains a statement that changes data (UPDATE, INSERT, DELETE, MERGE, `SELECT ... INTO`, DDL, EXEC; for MongoDB the write methods) first asks *You are running in Auto-commit mode. Data changes are saved permanently and cannot be rolled back.*, with the connection and the statement, and **Confirm** / **Cancel**. SELECT and files in Manual commit are not asked. It is on by default; right-click a group folder for **Auto-commit Confirmation…** (*On* / *Off*), or a connection (*On* / *Off* / *Same as group*). Groups and connections with the confirmation off show `no commit confirm` in **Connections**.

On SQL Server, MySQL / MariaDB and PostgreSQL the manual transaction runs on its own connection for the file:

- the transaction state comes from the server (SQL Server `@@TRANCOUNT`, MySQL / MariaDB and PostgreSQL from the protocol), not from a guess in the client;
- `COMMIT` and `ROLLBACK` inside the script are reported as *Transaction committed.* / *Transaction rolled back.*; on MySQL / MariaDB a DDL statement (CREATE, ALTER, DROP, TRUNCATE, …) that commits implicitly is reported too;
- on SQL Server the script is sent as a SQL batch (like SSMS), so `COMMIT`, `ROLLBACK` and `BEGIN TRAN` inside the script work without error 266, and `SET` options and `#temp` tables stay for the next run;
- a plain SELECT does not open a transaction when none is open; UPDATE, INSERT, DELETE, EXEC, `SELECT ... INTO` and (SQL Server) lock hints such as `UPDLOCK` / `HOLDLOCK` do;
- **Commit** commits every nested level on SQL Server (`BEGIN TRAN` twice is committed completely);
- PostgreSQL: after an error the transaction is aborted; the lens shows **TX aborted (rollback needed)**, a prompt offers **Rollback**, and **Commit** is refused (nothing can be committed);
- a lost connection is reported (the server has rolled back the transaction) and nothing is run;
- **Load more** and **Export → All Data** use the connection of the open transaction, so they see its uncommitted changes and do not wait for its locks;
- **Analyze** is refused while a transaction is open (it runs on another connection and would wait for the locks); **Explain** still works.

### 8. Autocomplete, formatter and lint

Columns are suggested for the tables of the statement under the cursor: after `FROM` / `JOIN` (in SELECT, WHERE, ON, `alias.`), and also for `UPDATE t SET` / `WHERE`, `INSERT INTO t (` (the column list) and `DELETE [FROM] t WHERE`.

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

### 10. Procedures, functions and views

On SQL Server, MySQL / MariaDB and PostgreSQL, right-click a view, procedure or function in **Connections** (on SQL Server also a trigger):

- **Show Definition**: the definition (`CREATE ...`) in a new tab;
- **Edit**: a script to change it, in a new tab: SQL Server `CREATE OR ALTER`; MySQL / MariaDB `CREATE OR REPLACE VIEW`, and `DROP ... IF EXISTS` + `CREATE` for procedures and functions (run the whole script); PostgreSQL `CREATE OR REPLACE`;
- **Run Procedure…** (procedures and functions): a script that calls it with every argument (procedures: SQL Server `EXEC`, MySQL / MariaDB and PostgreSQL `CALL`; functions: `SELECT`, on PostgreSQL `SELECT * FROM`). Each argument starts as `NULL` with its name and type as a comment. On SQL Server and MySQL / MariaDB, OUT / INOUT arguments are declared as variables and selected afterwards; on PostgreSQL the OUT arguments of a function are left out (they are result columns) and those of a procedure are `NULL`. Arguments with a default are passed as `DEFAULT` on SQL Server and commented out on PostgreSQL. A routine without arguments runs at once.

Procedure and function nodes expand to their parameters. When a script is split into statements, routine bodies stay whole: up to `GO` on SQL Server, `BEGIN … END` on MySQL / MariaDB and `$$ … $$` on PostgreSQL.

### 11. SQL Server Object Explorer

A SQL Server connection is shown like the Object Explorer of the mssql extension:

- connection → **Databases** (with **System Databases** apart), **Security** (Logins, Server Roles with their members, Credentials, Cryptographic Providers, Audits, Server Audit Specifications), **Server Objects** (Endpoints, Linked Servers, Triggers) and **SQL Server Agent** (service status and Jobs; right-click a job for **Start Job** / **Stop Job**, both ask to confirm);
- database → **Tables** / System Tables and **Views** / System Views (grouped by schema), **Synonyms**, **Programmability** (Stored Procedures, Table-valued / Scalar-valued / Aggregate Functions, Database Triggers, Types, Sequences) and **Security** (Users, Roles, Schemas);
- table → **Columns**, **Keys**, **Constraints**, **Triggers**, **Indexes** and **Statistics**.

**Script as…** on a table, view, procedure, function or trigger opens a script in a new tab: CREATE, ALTER (not for tables), DROP, and for tables and views SELECT (tables also INSERT, UPDATE, DELETE). CREATE TABLE is complete: identity, computed columns, defaults, collation, keys, checks, foreign keys and indexes. INSERT and UPDATE skip identity, computed and rowversion columns. Functions and triggers also have **Show Definition** / **Edit**, functions **Run**.

Right-click a SQL Server connection for **Activity Monitor (sessions / blocking)**, **Kill Session…** (asks to confirm; the open transaction of that session is rolled back) and **Server Info**; right-click a database for **Database Info**, **Backup Database (script)…** and **Restore Database (script)…**. Backup and restore only open a script; it is never run automatically.

When the login lacks a permission, the folder shows a hint that names it (for example *needs VIEW SERVER STATE*) instead of an error.

### 12. Live Monitor

Right-click a SQL Server, MySQL / MariaDB or PostgreSQL connection (the whole server) or a database (that database only) for **Live Monitor (charts)**. Choose **Refresh** (1, 2, 5, 10, 30 or 60 s) and **Window** (1, 5 or 15 min), or **Pause**.

![Live Monitor for SQL Server: charts for CPU %, Batch requests/sec, Waiting tasks, Database I/O MB/s, User connections and Transactions/sec, and the Running queries tab with a blocked SELECT shown in red](images/screenshots/monitor.png)

The charts depend on the database:

- SQL Server: CPU %, Batch requests/sec, Waiting tasks, Database I/O MB/s (read / write), User connections, Transactions/sec;
- MySQL / MariaDB: Queries/sec, Transactions/sec, Threads connected, Threads running, Network MB/s, InnoDB I/O MB/s, Row lock waits;
- PostgreSQL: Transactions/sec, Rows read / written per sec, Disk blocks read/sec, Cache hit %, Connections, Active / waiting.

Under the charts, tabs show **Running queries** (with the current statement), **Sessions / Blocking** (SQL Server, PostgreSQL) or **Sessions** and **Blocking** (MySQL / MariaDB), **Top waits** and **File I/O** (SQL Server), and **Expensive queries** (on MySQL / MariaDB it needs `performance_schema`, on PostgreSQL the `pg_stat_statements` extension; otherwise the tab says so). Blocked and blocking sessions are shown in red. **Kill** (or **Kill blocker** in the Blocking tab) asks to confirm; **Open as query** opens the tab's query in a `.sql` file, so the rows can be filtered and exported in the grid.

The monitor does not count its own queries. When monitoring one database, values that only exist for the whole server are labelled *(server)*. Polling stops while the monitor tab is hidden or paused. On SQL Server the login needs VIEW SERVER STATE.

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
| `Moonage Daydream: Import Connections from DBCode…` | Copy the connections from `dbcode.connections` (without passwords; Connections view **⋯** menu) |
| `Moonage Daydream: Rename…` / `Change Color…` | Rename a connection or change its color (Connections view) |
| `Moonage Daydream: Select Connection` | Choose the active connection |
| `Moonage Daydream: Move to Group…` / `Rename Group…` | Connection groups (Connections view) |
| `Moonage Daydream: Auto-commit Confirmation…` | Ask before data changes in Auto-commit mode: On / Off per group, On / Off / Same as group per connection |
| `Moonage Daydream: Show Definition` / `Edit (CREATE OR ALTER script)` / `Run Procedure…` | View, procedure, function (and SQL Server trigger) in Connections |
| `Moonage Daydream: Script as…` | SQL Server: CREATE / ALTER / DROP / SELECT / INSERT / UPDATE / DELETE script |
| `Moonage Daydream: Start Job` / `Stop Job` | SQL Server Agent job (asks to confirm) |
| `Moonage Daydream: Live Monitor (charts)` | Live charts and sessions for a connection or database (SQL Server, MySQL / MariaDB, PostgreSQL) |
| `Moonage Daydream: Activity Monitor (sessions / blocking)` / `Kill Session…` | SQL Server sessions and blocking |
| `Moonage Daydream: Server Info` / `Database Info` | SQL Server connection or database details |
| `Moonage Daydream: Backup Database (script)…` / `Restore Database (script)…` | SQL Server BACKUP / RESTORE script (never run automatically) |
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
- Import connection string: a `mongodb://` URL with several hosts (replica set) is not supported; use `mongodb+srv://` or one host.
- The grid holds at most 50,000 rows (Load more stops there); use Export for all data.
- SQLite has no Analyze (only `EXPLAIN QUERY PLAN`).
- Script as CREATE TABLE (SQL Server) has no partitioning, compression, filegroups, columnstore, temporal or memory-optimized options.
- Live Monitor: MySQL / MariaDB has no CPU % chart; PostgreSQL statistics are flushed with about 1 s delay; Expensive queries need `performance_schema` (MySQL / MariaDB) or `pg_stat_statements` (PostgreSQL).
- Auto-commit confirmation: EXEC / CALL always asks, since the procedure body is not inspected.

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

Copyright (C) 2026 Exel Tarkus.

Moonage Daydream is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version (GPL-3.0-or-later).

It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

### Credits

Database logos in the Connections view (`media/db/*.svg`) are from [devicon](https://github.com/devicons/devicon) 2.18.0 (MIT License). The logos are trademarks of their owners and are used only to identify the database type of a connection; see [media/db/NOTICE.md](media/db/NOTICE.md).
