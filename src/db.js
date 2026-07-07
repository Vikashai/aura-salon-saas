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

const TENANT_TABLES=['customers','sales','sale_items','capacity_pools','services','staff','service_staff','products','packages','expenses','users','audit_logs','settings','appointments','loyalty_transactions','referral_credit_transactions'];
const tenantTablePattern=new RegExp(`\\b(?:${TENANT_TABLES.join('|')})\\b`,'i');
function assertTenantScoped(sql) {
  const text=String(sql||'');
  if(tenantTablePattern.test(text)&&!/[.`]salon_id\b|\bsalon_id\b/i.test(text))throw new Error('Tenant-owned query is missing salon_id scope');
}

async function rows(sql, params = {}) {
  assertTenantScoped(sql);
  const [result] = await pool.execute(sql, params);
  return result;
}

async function one(sql, params = {}) {
  const result = await rows(sql, params);
  return result[0] || null;
}

// Control-plane and cross-tenant background work must opt in explicitly.
async function platformRows(sql,params={}) { const [result]=await pool.execute(sql,params);return result; }
async function platformOne(sql,params={}) { const result=await platformRows(sql,params);return result[0]||null; }

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

module.exports={pool,rows,one,transaction,platformRows,platformOne,assertTenantScoped};
