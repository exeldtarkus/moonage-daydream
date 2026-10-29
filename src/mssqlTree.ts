import type { ObjectKind } from './db';

/**
 * Folder Object Explorer SQL Server (seperti SSMS / extension mssql). sql: baris { schema?, name, description? };
 * db = database folder / objek; @full = nama objek tiga bagian (level tabel) atau nama item induk (anggota role).
 */
export interface MsFolder {
  label: string;
  icon: string;
  folders?: string[];
  sql?: (db: string) => string;
  /** baris = database (node database) */
  databases?: boolean;
  /** kolom tabel / view (driver.columns) */
  columns?: boolean;
  /** obj = objek (Select Top / Show / Edit / Run); children = folder anak tiap item (@full = nama item) */
  item?: { obj?: ObjectKind; icon?: string; context?: string; children?: string };
}

const b = (db: string) => `[${db.replace(/]/g, ']]')}]`;
/** objek user / bawaan (sys.objects dan turunannya) dengan schema */
const objs = (db: string, from: string, where: string, desc = 'NULL') =>
  `SELECT s.name AS [schema], o.name, ${desc} AS description FROM ${b(db)}.sys.${from} o JOIN ${b(db)}.sys.schemas s ON s.schema_id = o.schema_id WHERE ${where} ORDER BY 1, 2`;
const state = (col: string) => `CASE WHEN ${col} = 1 THEN 'enabled' ELSE 'disabled' END`;
const dbs = (where: string) => `SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 AND (${where}) ORDER BY name`;
const PRINCIPALS = "'S', 'U', 'G', 'E', 'X', 'C', 'K'";

export const MS_TREE: Record<string, MsFolder> = {
  // server
  databases: { label: 'Databases', icon: 'folder-library', folders: ['systemDatabases'], databases: true, sql: () => dbs('database_id > 4 AND is_distributor = 0') },
  systemDatabases: { label: 'System Databases', icon: 'folder', databases: true, sql: () => dbs('database_id <= 4 OR is_distributor = 1') },
  security: { label: 'Security', icon: 'shield', folders: ['logins', 'serverRoles', 'credentials', 'cryptoProviders', 'audits', 'auditSpecs'] },
  logins: { label: 'Logins', icon: 'folder', item: { icon: 'person', context: 'login' },
    sql: () => `SELECT name, type_desc AS description FROM sys.server_principals WHERE type IN (${PRINCIPALS}) AND name NOT LIKE '##%' ORDER BY name` },
  serverRoles: { label: 'Server Roles', icon: 'folder', item: { icon: 'organization', context: 'serverRole', children: 'roleMembers' },
    sql: () => "SELECT name, CASE WHEN is_fixed_role = 1 THEN 'fixed role' END AS description FROM sys.server_principals WHERE type = 'R' ORDER BY name" },
  roleMembers: { label: 'Members', icon: 'folder', item: { icon: 'person', context: 'member' },
    sql: () => `SELECT m.name, m.type_desc AS description FROM sys.server_role_members rm JOIN sys.server_principals r ON r.principal_id = rm.role_principal_id
      JOIN sys.server_principals m ON m.principal_id = rm.member_principal_id WHERE r.name = @full ORDER BY m.name` },
  credentials: { label: 'Credentials', icon: 'folder', item: { icon: 'key', context: 'credential' },
    sql: () => 'SELECT name, credential_identity AS description FROM sys.credentials ORDER BY name' },
  cryptoProviders: { label: 'Cryptographic Providers', icon: 'folder', item: { icon: 'lock', context: 'cryptoProvider' },
    sql: () => `SELECT name, ${state('is_enabled')} AS description FROM sys.cryptographic_providers ORDER BY name` },
  audits: { label: 'Audits', icon: 'folder', item: { icon: 'checklist', context: 'audit' },
    sql: () => `SELECT name, type_desc + ', ' + ${state('is_state_enabled')} AS description FROM sys.server_audits ORDER BY name` },
  auditSpecs: { label: 'Server Audit Specifications', icon: 'folder', item: { icon: 'checklist', context: 'auditSpec' },
    sql: () => `SELECT name, ${state('is_state_enabled')} AS description FROM sys.server_audit_specifications ORDER BY name` },
  serverObjects: { label: 'Server Objects', icon: 'server-environment', folders: ['endpoints', 'linkedServers', 'serverTriggers'] },
  endpoints: { label: 'Endpoints', icon: 'folder', item: { icon: 'plug', context: 'endpoint' },
    sql: () => "SELECT name, protocol_desc + ' · ' + type_desc + ' · ' + state_desc AS description FROM sys.endpoints ORDER BY endpoint_id" },
  linkedServers: { label: 'Linked Servers', icon: 'folder', item: { icon: 'remote', context: 'linkedServer' },
    sql: () => "SELECT name, product + ISNULL(' · ' + data_source, '') AS description FROM sys.servers WHERE is_linked = 1 ORDER BY name" },
  serverTriggers: { label: 'Triggers', icon: 'folder', item: { icon: 'zap', context: 'serverTrigger' },
    sql: () => "SELECT name, CASE WHEN is_disabled = 1 THEN 'disabled' END AS description FROM sys.server_triggers ORDER BY name" },
  // status service Agent (Running / Stopped) di samping folder Jobs: daftar job kosong tidak membingungkan saat Agent mati
  agent: { label: 'SQL Server Agent', icon: 'clock', folders: ['jobs'], item: { icon: 'pulse', context: 'agentService' },
    sql: () => "SELECT servicename AS name, status_desc AS description FROM sys.dm_server_services WHERE servicename LIKE 'SQL Server Agent%'" },
  jobs: { label: 'Jobs', icon: 'folder', item: { icon: 'clock', context: 'job' },
    sql: () => `SELECT j.name, ${state('j.enabled')} + ISNULL(' · last run ' + CASE h.run_status WHEN 0 THEN 'failed' WHEN 1 THEN 'succeeded'
      WHEN 2 THEN 'retry' WHEN 3 THEN 'canceled' WHEN 4 THEN 'in progress' END, '') AS description FROM msdb.dbo.sysjobs j
      OUTER APPLY (SELECT TOP 1 run_status FROM msdb.dbo.sysjobhistory WHERE job_id = j.job_id AND step_id = 0 ORDER BY instance_id DESC) h ORDER BY j.name` },

  // database
  tables: { label: 'Tables', icon: 'folder', folders: ['systemTables'], item: { obj: 'table' }, sql: (db) => objs(db, 'tables', 'o.is_ms_shipped = 0') },
  systemTables: { label: 'System Tables', icon: 'folder', item: { obj: 'table' }, sql: (db) => objs(db, 'tables', 'o.is_ms_shipped = 1') },
  views: { label: 'Views', icon: 'folder', folders: ['systemViews'], item: { obj: 'view' }, sql: (db) => objs(db, 'views', 'o.is_ms_shipped = 0') },
  // ~600 view bawaan: dikelompokkan per schema (sys, INFORMATION_SCHEMA)
  systemViews: { label: 'System Views', icon: 'folder', item: { icon: 'symbol-namespace', context: 'schemaGroup', children: 'systemViewsInSchema' },
    sql: (db) => `SELECT DISTINCT s.name FROM ${b(db)}.sys.all_views o JOIN ${b(db)}.sys.schemas s ON s.schema_id = o.schema_id WHERE o.is_ms_shipped = 1 ORDER BY 1` },
  systemViewsInSchema: { label: 'System Views', icon: 'folder', item: { obj: 'view' }, sql: (db) => objs(db, 'all_views', 'o.is_ms_shipped = 1 AND s.name = @full') },
  synonyms: { label: 'Synonyms', icon: 'folder', item: { icon: 'link', context: 'synonym' }, sql: (db) => objs(db, 'synonyms', '1 = 1', 'o.base_object_name') },
  programmability: { label: 'Programmability', icon: 'folder', folders: ['procedures', 'functions', 'dbTriggers', 'types', 'sequences'] },
  procedures: { label: 'Stored Procedures', icon: 'folder', item: { obj: 'procedure' }, sql: (db) => objs(db, 'procedures', 'o.is_ms_shipped = 0') },
  functions: { label: 'Functions', icon: 'folder', folders: ['tvf', 'scalarFunctions', 'aggregateFunctions'] },
  tvf: { label: 'Table-valued Functions', icon: 'folder', item: { obj: 'function' }, sql: (db) => objs(db, 'objects', "o.type IN ('IF', 'TF', 'FT') AND o.is_ms_shipped = 0") },
  scalarFunctions: { label: 'Scalar-valued Functions', icon: 'folder', item: { obj: 'function' }, sql: (db) => objs(db, 'objects', "o.type IN ('FN', 'FS') AND o.is_ms_shipped = 0") },
  aggregateFunctions: { label: 'Aggregate Functions', icon: 'folder', item: { icon: 'symbol-function', context: 'aggregate' }, sql: (db) => objs(db, 'objects', "o.type = 'AF'") },
  // trigger database tanpa schema: Show / Edit mencari lewat nama (lihat mssql definition)
  dbTriggers: { label: 'Database Triggers', icon: 'folder', item: { obj: 'trigger' },
    sql: (db) => `SELECT '' AS [schema], name, CASE WHEN is_disabled = 1 THEN 'disabled' END AS description FROM ${b(db)}.sys.triggers WHERE parent_class = 0 ORDER BY name` },
  types: { label: 'Types', icon: 'folder', item: { icon: 'symbol-class', context: 'type' },
    sql: (db) => objs(db, 'types', 'o.is_user_defined = 1', "CASE WHEN o.is_table_type = 1 THEN 'table type' ELSE TYPE_NAME(o.system_type_id) END") },
  sequences: { label: 'Sequences', icon: 'folder', item: { icon: 'symbol-number', context: 'sequence' }, sql: (db) => objs(db, 'sequences', '1 = 1', 'TYPE_NAME(o.system_type_id)') },
  dbSecurity: { label: 'Security', icon: 'shield', folders: ['users', 'roles', 'schemas'] },
  users: { label: 'Users', icon: 'folder', item: { icon: 'person', context: 'user' },
    sql: (db) => `SELECT name, type_desc AS description FROM ${b(db)}.sys.database_principals WHERE type IN (${PRINCIPALS}) ORDER BY name` },
  roles: { label: 'Roles', icon: 'folder', item: { icon: 'organization', context: 'role' },
    sql: (db) => `SELECT name, type_desc AS description FROM ${b(db)}.sys.database_principals WHERE type IN ('R', 'A') ORDER BY name` },
  schemas: { label: 'Schemas', icon: 'folder', item: { icon: 'symbol-namespace', context: 'schema' }, sql: (db) => `SELECT name FROM ${b(db)}.sys.schemas ORDER BY name` },

  // tabel / view (@full = [db].[schema].[nama])
  columns: { label: 'Columns', icon: 'folder', columns: true },
  keys: { label: 'Keys', icon: 'folder', item: { icon: 'key', context: 'key' },
    sql: (db) => `SELECT name, type_desc AS description FROM ${b(db)}.sys.key_constraints WHERE parent_object_id = OBJECT_ID(@full)
      UNION ALL SELECT name, 'FOREIGN_KEY_CONSTRAINT' FROM ${b(db)}.sys.foreign_keys WHERE parent_object_id = OBJECT_ID(@full) ORDER BY 1` },
  constraints: { label: 'Constraints', icon: 'folder', item: { icon: 'symbol-constant', context: 'constraint' },
    sql: (db) => `SELECT name, 'CHECK ' + definition AS description FROM ${b(db)}.sys.check_constraints WHERE parent_object_id = OBJECT_ID(@full)
      UNION ALL SELECT name, 'DEFAULT ' + definition FROM ${b(db)}.sys.default_constraints WHERE parent_object_id = OBJECT_ID(@full) ORDER BY 1` },
  tTriggers: { label: 'Triggers', icon: 'folder', item: { obj: 'trigger' },
    sql: (db) => `SELECT s.name AS [schema], t.name, CASE WHEN t.is_disabled = 1 THEN 'disabled' END AS description FROM ${b(db)}.sys.triggers t
      JOIN ${b(db)}.sys.objects o ON o.object_id = t.object_id JOIN ${b(db)}.sys.schemas s ON s.schema_id = o.schema_id WHERE t.parent_id = OBJECT_ID(@full) ORDER BY 2` },
  indexes: { label: 'Indexes', icon: 'folder', item: { icon: 'list-ordered', context: 'index' },
    sql: (db) => `SELECT name, type_desc + CASE WHEN is_unique = 1 THEN ', unique' ELSE '' END + CASE WHEN is_primary_key = 1 THEN ', primary key' ELSE '' END AS description
      FROM ${b(db)}.sys.indexes WHERE object_id = OBJECT_ID(@full) AND type > 0 ORDER BY name` },
  statistics: { label: 'Statistics', icon: 'folder', item: { icon: 'graph', context: 'statistic' },
    sql: (db) => `SELECT name, CASE WHEN auto_created = 1 THEN 'auto created' END AS description FROM ${b(db)}.sys.stats WHERE object_id = OBJECT_ID(@full) ORDER BY name` },
};

export const MS_SERVER = ['databases', 'security', 'serverObjects', 'agent'];
export const MS_DB = ['tables', 'views', 'synonyms', 'programmability', 'dbSecurity'];
export const MS_TABLE = ['columns', 'keys', 'constraints', 'tTriggers', 'indexes', 'statistics'];
export const MS_VIEW = ['columns', 'tTriggers', 'indexes', 'statistics'];

/** error SQL Server karena izin: 229 / 262 / 297 / 300 / 916 / 15247 */
const PERMISSION_ERRORS = new Set([229, 262, 297, 300, 916, 15247]);
const HINTS: Record<string, string> = {
  jobs: 'No permission (needs SQLAgentReaderRole in msdb, or access to msdb)',
  audits: 'No permission (needs ALTER ANY SERVER AUDIT or VIEW SERVER STATE)',
  auditSpecs: 'No permission (needs ALTER ANY SERVER AUDIT or VIEW SERVER STATE)',
  agent: 'No permission to read the Agent service status (needs VIEW SERVER STATE)',
  credentials: 'No permission (needs VIEW ANY DEFINITION)',
};

/** pesan izin untuk folder (node abu-abu, bukan error merah); undefined = bukan masalah izin */
export function permissionHint(folder: string, e: unknown): string | undefined {
  const n = (e as { number?: number; originalError?: { info?: { number?: number } } })?.number ?? (e as { originalError?: { info?: { number?: number } } })?.originalError?.info?.number;
  if (n === undefined || !PERMISSION_ERRORS.has(n)) return undefined;
  return HINTS[folder] ?? 'No permission to list this (needs VIEW DEFINITION / VIEW ANY DEFINITION)';
}
