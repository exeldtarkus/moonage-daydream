-- Moonage test: hasil besar (jutaan baris dari cross join katalog sistem), hanya 1000 baris pertama ditampilkan
-- Coba klik Cancel di panel hasil beberapa detik setelah dijalankan (SELECT saja, tidak mengubah data)
SELECT
    a.name AS a_name
    , b.name AS b_name
FROM sys.all_objects a
CROSS JOIN sys.all_objects b;
