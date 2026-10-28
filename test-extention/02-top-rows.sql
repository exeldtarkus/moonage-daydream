-- Moonage test: data kecil, 2 result set dalam 1 run (SELECT saja)
SELECT TOP 20
    name
    , object_id
    , type_desc
    , create_date
FROM sys.objects;

SELECT
    COUNT(*) AS total_objects
FROM sys.objects;
