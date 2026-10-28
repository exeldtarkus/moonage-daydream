-- Moonage test: query lambat 20 detik untuk mencoba tombol Cancel
-- (WAITFOR hanya menunggu, tidak mengubah data)
WAITFOR DELAY '00:00:20';
SELECT
    'selesai tanpa cancel' AS info;
