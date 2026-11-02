import type { DbObject } from './db';

/** template objek SQL Server baru dari tombol (+) folder Object Explorer: dibuka sebagai script, tidak dijalankan otomatis */
export interface NewObjectTemplate { label: string; sql: string }

const q = (s: string) => `[${s.replace(/]/g, ']]')}]`;

const SCALAR: NewObjectTemplate = { label: 'Scalar function', sql: `CREATE FUNCTION [dbo].[fn_NewScalar] (@Value INT)
RETURNS INT
AS
BEGIN
    RETURN @Value * 2;
END;` };

const INLINE_TVF: NewObjectTemplate = { label: 'Inline table-valued function', sql: `CREATE FUNCTION [dbo].[fn_NewInline] (@MinId INT)
RETURNS TABLE
AS
RETURN
(
    SELECT o.object_id, o.name
    FROM sys.objects AS o
    WHERE o.object_id >= @MinId
);` };

const MULTI_TVF: NewObjectTemplate = { label: 'Multi-statement table-valued function', sql: `CREATE FUNCTION [dbo].[fn_NewMulti] (@MinId INT)
RETURNS @Result TABLE (Id INT NOT NULL, Name SYSNAME NOT NULL)
AS
BEGIN
    INSERT INTO @Result (Id, Name)
    SELECT o.object_id, o.name
    FROM sys.objects AS o
    WHERE o.object_id >= @MinId;
    RETURN;
END;` };

const ddlTrigger = (name: string, on: string, events: string, what: string): NewObjectTemplate => ({ label: `${what} trigger`, sql: `-- events: see sys.trigger_event_types
CREATE TRIGGER ${q(name)}
ON ${on}
FOR ${events}
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @e XML = EVENTDATA();
    DECLARE @type NVARCHAR(100) = @e.value('(/EVENT_INSTANCE/EventType)[1]', 'nvarchar(100)');
    PRINT CONCAT('${what} event: ', @type);
END;` });

const STATIC: Record<string, NewObjectTemplate[]> = {
  serverTriggers: [ddlTrigger('TR_Server_DDL', 'ALL SERVER', 'CREATE_DATABASE, ALTER_DATABASE, DROP_DATABASE', 'Server')],
  procedures: [{ label: 'Stored procedure', sql: `CREATE PROCEDURE [dbo].[usp_NewProcedure]
    @Id INT,
    @Name NVARCHAR(100) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    SELECT @Id AS Id, @Name AS Name;
END;` }],
  functions: [SCALAR, INLINE_TVF, MULTI_TVF],
  scalarFunctions: [SCALAR],
  tvf: [INLINE_TVF, MULTI_TVF],
  dbTriggers: [ddlTrigger('TR_Database_DDL', 'DATABASE', 'CREATE_TABLE, ALTER_TABLE, DROP_TABLE', 'Database')],
  types: [
    { label: 'User-defined data type', sql: 'CREATE TYPE [dbo].[PhoneNumber] FROM NVARCHAR(20) NOT NULL;' },
    { label: 'User-defined table type', sql: `CREATE TYPE [dbo].[IdList] AS TABLE
(
    Id INT NOT NULL PRIMARY KEY
);` },
  ],
  sequences: [{ label: 'Sequence', sql: `CREATE SEQUENCE [dbo].[seq_New]
    AS BIGINT
    START WITH 1
    INCREMENT BY 1
    MINVALUE 1
    NO MAXVALUE
    NO CYCLE
    CACHE 50;` }],
  views: [{ label: 'View', sql: `CREATE VIEW [dbo].[vw_New]
-- WITH SCHEMABINDING -- uncomment to bind to the base tables (two-part names, no SELECT *)
AS
SELECT o.object_id, o.name, o.type_desc
FROM sys.objects AS o;` }],
};

/** folder yang punya tombol (+) */
export const NEW_OBJECT_FOLDERS = [...Object.keys(STATIC), 'tTriggers'];

/** template untuk folder (kosong = folder tanpa tombol +); tTriggers memakai tabel / view induknya */
export function newObjectTemplates(folder: string, ctx: { obj?: DbObject; view?: boolean }): NewObjectTemplate[] {
  if (folder !== 'tTriggers') return STATIC[folder] ?? [];
  const o = ctx.obj ?? { schema: 'dbo', name: 'TableName' };
  const timing = ctx.view ? 'INSTEAD OF' : 'AFTER';
  return [{ label: `${ctx.view ? 'View' : 'Table'} trigger`, sql: `CREATE TRIGGER ${q(o.schema)}.${q(`TR_${o.name}_Change`)}
ON ${q(o.schema)}.${q(o.name)}
${timing} INSERT, UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    -- inserted = new rows, deleted = old rows${ctx.view ? '\n    -- INSTEAD OF: write the changes to the base tables here' : ''}
    DECLARE @ins INT = (SELECT COUNT(*) FROM inserted), @del INT = (SELECT COUNT(*) FROM deleted);
    PRINT CONCAT('${o.name.replace(/'/g, "''")}: ', @ins, ' inserted, ', @del, ' deleted');
END;` }];
}
