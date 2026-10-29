import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { importDbcode, parseConnectionString } from '../connString';

test('connection string: SQL Server ADO.NET (Server / Data Source, port after comma, Encrypt / TrustServerCertificate)', () => {
  assert.deepEqual(parseConnectionString('Server=tcp:db.example.com,1444;Initial Catalog=shop;User ID=app;Password=p@ss;Encrypt=True;TrustServerCertificate=False;'),
    { type: 'mssql', host: 'db.example.com', port: '1444', user: 'app', password: 'p@ss', database: 'shop', ssl: true, trust: false });
  assert.deepEqual(parseConnectionString('Data Source=SVR01\\SQLEXPRESS;Database=x;Integrated Security=SSPI'),
    { type: 'mssql', host: 'SVR01', instance: 'SQLEXPRESS', port: '1433', database: 'x', auth: 'windows' }, 'named instance, Windows authentication');
  assert.deepEqual(parseConnectionString("server=h;uid=u;pwd='a;b';database=d"),
    { type: 'mssql', host: 'h', port: '1433', user: 'u', password: 'a;b', database: 'd' }, 'aliases, quoted value with ;');
});

test('connection string: URLs mysql / mariadb / postgres (decoded user / password, default port, ssl)', () => {
  assert.deepEqual(parseConnectionString('mysql://root:pa%40ss@192.0.2.5:3307/shop?ssl=true'),
    { type: 'mysql', host: '192.0.2.5', port: '3307', user: 'root', password: 'pa@ss', database: 'shop', ssl: true });
  assert.deepEqual(parseConnectionString('mariadb://u@h/db'), { type: 'mariadb', host: 'h', port: '3306', user: 'u', database: 'db' });
  assert.deepEqual(parseConnectionString('postgresql://postgres:secret@localhost/shop?sslmode=require'),
    { type: 'postgres', host: 'localhost', port: '5432', user: 'postgres', password: 'secret', database: 'shop', ssl: true });
  assert.deepEqual(parseConnectionString('  postgres://h:6543  '), { type: 'postgres', host: 'h', port: '6543' });
});

test('connection string: MongoDB (authSource, other options as driver settings, +srv keeps the URL as host)', () => {
  assert.deepEqual(parseConnectionString('mongodb://app:p%2Fw@192.0.2.10:27017/orders?authSource=admin&tls=true&replicaSet=rs0'),
    { type: 'mongodb', host: '192.0.2.10', port: '27017', user: 'app', password: 'p/w', database: 'orders', authSource: 'admin', ssl: true, options: { replicaSet: 'rs0' } });
  assert.deepEqual(parseConnectionString('mongodb+srv://u:p@cluster0.ab.mongodb.net/app?retryWrites=true'),
    { type: 'mongodb', host: 'mongodb+srv://cluster0.ab.mongodb.net', port: '27017', user: 'u', password: 'p', database: 'app', options: { retryWrites: 'true' } });
});

test('connection string: unknown text is refused with a clear error', () => {
  assert.throws(() => parseConnectionString(''), /Paste a connection string/);
  assert.throws(() => parseConnectionString('redis://h:6379'), /Unsupported connection string/);
  assert.throws(() => parseConnectionString('just some text'), /Unsupported connection string/);
});

test('DBCode import: dbcode.connections -> connections without password, existing names skipped', () => {
  const list = [
    { name: '192.0.2.20 - SQLEXPRESS', driver: 'mssql', host: '192.0.2.20', port: 1433, ssl: false, username: 'app', password: '', savePassword: 'secretStorage',
      readOnly: false, connectionTimeout: 30, group: 'non-prod/uat', driverOptions: { authType: 'sql', instance: 'SQLEXPRESS' } },
    { name: 'SQL-SVR-01', driver: 'mssql', host: 'SQL-SVR-01', port: 1433, ssl: true, authMethod: 'windows', username: 'exel', database: 'master',
      readOnly: true, connectionTimeout: 15, driverOptions: { domain: 'CORP' } },
    { name: 'orders-db', driver: 'mongodb', host: '192.0.2.10', port: 27017, username: 'app', database: 'orders', connectionTimeout: 30, driverOptions: { protocol: 'mongodb://' } },
    { name: 'atlas', driver: 'mongodb', host: 'cluster0.ab.mongodb.net', port: 27017, username: 'u', driverOptions: { protocol: 'mongodb+srv://' } },
    { name: 'shop-pg', driver: 'postgres', host: '192.0.2.10', port: 5432, username: 'postgres', database: 'shop', group: 'non-prod/uat' },
    { name: 'taken', driver: 'mysql', host: 'h', port: 3306, username: 'u' },
    { name: 'redis', driver: 'redis', host: 'h', port: 6379 },
    'garbage',
  ];
  const { conns, skipped } = importDbcode(list, new Set(['taken']));
  assert.deepEqual(conns, [
    { name: '192.0.2.20 - SQLEXPRESS', type: 'mssql', host: '192.0.2.20', port: 1433, instance: 'SQLEXPRESS', user: 'app', database: '', trustServerCertificate: true,
      ssl: false, connectTimeout: 30, group: 'non-prod/uat' },
    { name: 'SQL-SVR-01', type: 'mssql', host: 'SQL-SVR-01', port: 1433, user: 'exel', database: 'master', trustServerCertificate: true,
      auth: 'windows', domain: 'CORP', ssl: true, connectTimeout: 15, readOnly: true },
    { name: 'orders-db', type: 'mongodb', host: '192.0.2.10', port: 27017, user: 'app', database: 'orders', trustServerCertificate: false, connectTimeout: 30 },
    { name: 'atlas', type: 'mongodb', host: 'mongodb+srv://cluster0.ab.mongodb.net', port: 27017, user: 'u', database: '', trustServerCertificate: false },
    { name: 'shop-pg', type: 'postgres', host: '192.0.2.10', port: 5432, user: 'postgres', database: 'shop', trustServerCertificate: false, group: 'non-prod/uat' },
  ]);
  assert.deepEqual(skipped, ['taken (name already used)', 'redis (redis not supported)', '(invalid entry)']);
  assert.ok(conns.every((c) => !('password' in c)), 'passwords are never imported');
});
