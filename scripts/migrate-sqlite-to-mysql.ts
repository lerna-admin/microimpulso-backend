import BetterSqlite3 = require('better-sqlite3');
import * as mysql from 'mysql2/promise';

type MysqlColumnInfo = {
  Field: string;
  Type: string;
};

function formatDateOnly(value: any): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(String(value).trim());
  if (Number.isNaN(date.getTime())) return null;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatDateTime(value: any): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(String(value).trim());
  if (Number.isNaN(date.getTime())) return null;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

const SQLITE_PATH = 'database.sqlite.mysql-migration';
const MYSQL_CONFIG = {
  host: 'localhost',
  port: 3306,
  user: 'microimpulso_user',
  password: 'MiAppDb#2025',
  database: 'microimpulso_app',
};

async function migrate() {
  const sqlite = new BetterSqlite3(SQLITE_PATH, { readonly: true });
  const mysqlConn = await mysql.createConnection(MYSQL_CONFIG);

  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name as string)
    .filter((name) => name && name !== 'typeorm_metadata');

  console.log(`[migrate] Migrating ${tables.length} tables from ${SQLITE_PATH} to MySQL`);

  await mysqlConn.query('SET FOREIGN_KEY_CHECKS=0');

  for (const table of tables) {
    const columnsInfo = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    const columns = columnsInfo.map((col) => col.name);
    if (!columns.length) continue;

    const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, any>>;
    if (!rows.length) {
      console.log(`[migrate] Table ${table}: no rows to migrate`);
      continue;
    }

    const columnList = columns.map((col) => `\`${col}\``).join(', ');
    const placeholders = columns.map(() => '?').join(', ');

    let mysqlColumns: MysqlColumnInfo[];
    try {
      [mysqlColumns] = (await mysqlConn.query(`DESCRIBE \`${table}\``)) as [MysqlColumnInfo[], any];
    } catch (err: any) {
      if (err && err.code === 'ER_NO_SUCH_TABLE') {
        console.warn(`[migrate] Skipping table ${table} (not present in MySQL schema)`);
        continue;
      }
      throw err;
    }
    const mysqlTypes = new Map(mysqlColumns.map((col) => [col.Field, col.Type.toLowerCase()]));

    console.log(`[migrate] Table ${table}: ${rows.length} rows`);

    for (const row of rows) {
      const values = columns.map((col) => {
        const type = mysqlTypes.get(col) || '';
        let value = row[col];
        if (value === undefined || value === '') value = null;
        if (value !== null) {
          if (type.startsWith('date') && !type.startsWith('datetime')) {
            value = formatDateOnly(value);
          } else if (type.startsWith('datetime') || type.startsWith('timestamp')) {
            value = formatDateTime(value);
          }
        }
        return value;
      });
      await mysqlConn.execute(
        `INSERT INTO \`${table}\` (${columnList}) VALUES (${placeholders})`,
        values,
      );
    }
  }

  await mysqlConn.query('SET FOREIGN_KEY_CHECKS=1');
  await mysqlConn.end();
  sqlite.close();

  console.log('[migrate] Migration completed successfully');
}

migrate().catch((err) => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});
