'use strict';

require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const sourcePath = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'salon.db'));
const tables = ['customers','services','staff','products','packages','expenses','sales','sale_items','appointments','loyalty_transactions','settings'];

async function main() {
  if (!fs.existsSync(sourcePath)) throw new Error(`SQLite source not found: ${sourcePath}`);
  if (process.env.CONFIRM_DATA_MIGRATION !== 'YES') {
    throw new Error('Set CONFIRM_DATA_MIGRATION=YES before running this one-time migration.');
  }
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const target = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, charset: 'utf8mb4',
  });
  await target.beginTransaction();
  try {
    await target.query('SET FOREIGN_KEY_CHECKS=0');
    for (const table of [...tables].reverse()) await target.query(`TRUNCATE TABLE \`${table}\``);
    for (const table of tables) {
      const sourceColumns = source.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
      const [targetDefinition] = await target.query(`DESCRIBE \`${table}\``);
      const targetColumns = new Set(targetDefinition.map(column => column.Field));
      const targetTypes = new Map(targetDefinition.map(column => [column.Field, column.Type]));
      const columns = sourceColumns.filter(column => targetColumns.has(column));
      const records = source.prepare(`SELECT * FROM ${table}`).all();
      if (!records.length) continue;
      const columnSql = columns.map(column => `\`${column}\``).join(',');
      const placeholders = columns.map(() => '?').join(',');
      for (const record of records) {
        const values = columns.map(column => {
          const value = record[column];
          const type = targetTypes.get(column) || '';
          const requiresTypedValue = /^(?:tinyint|smallint|mediumint|int|bigint|decimal|numeric|float|double|date|datetime|timestamp|time)/i.test(type);
          return value === '' && requiresTypedValue ? null : value;
        });
        await target.execute(`INSERT INTO \`${table}\` (${columnSql}) VALUES (${placeholders})`, values);
      }
      console.log(`${table}: ${records.length} records`);
    }
    const password = process.env.INITIAL_ADMIN_PASSWORD;
    if (!password) throw new Error('INITIAL_ADMIN_PASSWORD is required to create a Node-compatible admin login.');
    const passwordHash = await bcrypt.hash(password, 12);
    await target.execute("UPDATE users SET password_hash=? WHERE username='admin'", [passwordHash]);
    await target.query('SET FOREIGN_KEY_CHECKS=1');
    await target.commit();
    console.log('Migration completed and admin password reset.');
  } catch (error) {
    await target.rollback();
    throw error;
  } finally {
    source.close();
    await target.end();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
