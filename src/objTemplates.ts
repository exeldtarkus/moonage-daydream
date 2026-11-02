import type { DbObject, DbType, ListKind, ObjectKind } from './db';
import type { NewObjectTemplate } from './msTemplates';

// SQL Server memakai template Object Explorer sendiri (msTemplates.ts); di sini MySQL / MariaDB, PostgreSQL, SQLite, MongoDB
const my = (s: string) => `\`${s.replace(/`/g, '``')}\``;
/** PostgreSQL: nama huruf kecil biasa tidak perlu dikutip */
const pg = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
const lite = (s: string) => `"${s.replace(/"/g, '""')}"`;

type What = 'view' | 'procedure' | 'trigger';

/**
 * template objek baru: (+) folder Views / Stored Procedures, klik kanan tabel -> New Trigger…; dibuka sebagai script, tidak dijalankan.
 * MySQL tanpa DELIMITER: pemisah statement extension sudah menghitung BEGIN ... END.
 */
export function objectTemplates(type: DbType, what: What | ListKind | ObjectKind, ctx: { db: string; obj?: DbObject }): NewObjectTemplate[] {
  const t = ctx.obj?.name ?? 'table_name';
  if (type === 'mysql' || type === 'mariadb') {
    const db = my(ctx.db);
    if (what === 'view') return [{ label: 'View', sql: `CREATE OR REPLACE VIEW ${db}.\`vw_new\` AS
SELECT table_name, table_rows
FROM information_schema.tables
WHERE table_schema = DATABASE();` }];
    if (what === 'procedure') return [
      { label: 'Stored procedure', sql: `CREATE PROCEDURE ${db}.\`sp_new\`(IN p_id INT, OUT p_name VARCHAR(100), INOUT p_counter INT)
BEGIN
  SET p_name = CONCAT('id ', p_id);
  SET p_counter = IFNULL(p_counter, 0) + 1;
END;` },
      { label: 'Function', sql: `CREATE FUNCTION ${db}.\`fn_new\`(p_value INT)
RETURNS INT
DETERMINISTIC
BEGIN
  RETURN p_value * 2;
END;` },
    ];
    if (what === 'trigger') return [{ label: 'Trigger', sql: `CREATE TRIGGER ${db}.${my(`trg_${t}_before_insert`)}
BEFORE INSERT ON ${db}.${my(t)}
FOR EACH ROW
BEGIN
  -- NEW.column = new values (BEFORE: may be changed), OLD.column on UPDATE / DELETE; also AFTER, UPDATE, DELETE
  SET @moonage_last_change = NOW();
END;` }];
  }
  if (type === 'postgres') {
    const s = pg(ctx.obj?.schema || 'public');
    if (what === 'view') return [
      { label: 'View', sql: `CREATE OR REPLACE VIEW ${s}.vw_new AS
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = '${(ctx.obj?.schema || 'public').replace(/'/g, "''")}';` },
      { label: 'Materialized view', sql: `CREATE MATERIALIZED VIEW ${s}.mv_new AS
SELECT table_name, table_type
FROM information_schema.tables
WITH DATA;
-- refresh later: REFRESH MATERIALIZED VIEW ${s}.mv_new;` },
    ];
    if (what === 'procedure') return [
      { label: 'Function', sql: `CREATE OR REPLACE FUNCTION ${s}.fn_new(p_value integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN p_value * 2;
END;
$$;` },
      { label: 'Procedure', sql: `CREATE OR REPLACE PROCEDURE ${s}.sp_new(IN p_id integer, INOUT p_name text DEFAULT NULL)
LANGUAGE plpgsql
AS $$
BEGIN
  p_name := 'id ' || p_id;
END;
$$;` },
    ];
    if (what === 'trigger') {
      const fn = `${s}.${pg(`trg_${t}_change`)}`;
      return [{ label: 'Trigger', sql: `CREATE OR REPLACE FUNCTION ${fn}()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- NEW = new row (INSERT / UPDATE), OLD = old row (UPDATE / DELETE)
  RAISE NOTICE '% on %', TG_OP, TG_TABLE_NAME;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER ${pg(`trg_${t}_change`)}
AFTER INSERT OR UPDATE OR DELETE ON ${s}.${pg(t)}
FOR EACH ROW EXECUTE FUNCTION ${fn}();` }];
    }
  }
  if (type === 'sqlite') {
    if (what === 'view') return [{ label: 'View', sql: `CREATE VIEW "vw_new" AS
SELECT name, type
FROM sqlite_master
WHERE type IN ('table', 'view');` }];
    if (what === 'trigger') return [{ label: 'Trigger', sql: `CREATE TRIGGER ${lite(`trg_${t}_after_insert`)}
AFTER INSERT ON ${lite(t)}
FOR EACH ROW
BEGIN
  -- NEW.column / OLD.column; also BEFORE, UPDATE, DELETE (INSTEAD OF only on views)
  SELECT NEW.rowid;
END;` }];
  }
  if (type === 'mongodb' && what === 'view') return [{ label: 'View', sql: `db.createView("vw_new", "sourceCollection", [
  { $match: {} },
  { $project: { _id: 1 } }
]);` }];
  return [];
}

/** context folder Explorer: .new = punya template (tombol +) */
export const folderContext = (type: DbType, kind: ListKind) => `folder.${kind}${objectTemplates(type, kind, { db: '' }).length ? '.new' : ''}`;
