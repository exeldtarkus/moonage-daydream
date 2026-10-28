-- Moonage test: query lintas database + autocomplete (SELECT saja)
-- Coba ketik: msdb.  lalu  dbo.  untuk saran schema / tabel
-- Dua SELECT tanpa variabel / #temp dijalankan paralel: yang cepat tampil duluan
SELECT TOP 10
    name
    , database_id
FROM master.sys.databases;

SELECT TOP 10
    name
    , enabled
FROM msdb.dbo.sysjobs;
