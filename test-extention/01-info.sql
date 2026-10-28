-- Moonage test: info server (SELECT saja)
-- Jalankan seluruh file: Ctrl+Alt+Enter
SELECT
    @@SERVERNAME AS server_name
    , DB_NAME() AS current_db
    , SUSER_SNAME() AS login_name
    , @@VERSION AS version;
GO

SELECT
    name
    , create_date
    , state_desc
FROM sys.databases
WHERE HAS_DBACCESS(name) = 1
ORDER BY name;
