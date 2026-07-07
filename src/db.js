'use strict';

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  timezone: '+05:30',
  decimalNumbers: true,
  namedPlaceholders: true,
  dateStrings: true,
  charset: 'utf8mb4',
});

async function rows(sql, params = {}) {
  const [result] = await pool.execute(sql, params);
  return result;
}

async function one(sql, params = {}) {
  const result = await rows(sql, params);
  return result[0] || null;
}

async function transaction(fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const value = await fn(connection);
    await connection.commit();
    return value;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { pool, rows, one, transaction };
