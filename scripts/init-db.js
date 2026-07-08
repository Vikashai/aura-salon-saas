'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const defaults = {
  salon_name: 'Aura Salon Studio', invoice_prefix: 'INV', gst_number: '', tax_enabled: '1',
  business_open: '09:00', business_close: '20:00', slot_interval: '30', salon_phone: '', salon_email: '',
  smtp_host: 'smtp.gmail.com', smtp_port: '587', smtp_user: '', smtp_pass: '', smtp_from: '',
  whatsapp_provider: 'meta', meta_whatsapp_token: '', meta_phone_number_id: '', meta_api_version: 'v25.0',
  meta_template_language: 'en_US', meta_template_confirmation: '', meta_template_reminder: '',
  meta_template_cancellation: '', meta_template_welcome: '', meta_template_birthday: '',
  meta_template_anniversary: '', twilio_sid: '', twilio_token: '',
  twilio_whatsapp_from: 'whatsapp:+14155238886', base_url: process.env.APP_BASE_URL || 'http://localhost:3000',
  loyalty_enabled: '1', loyalty_earn_rate: '2', loyalty_redeem_rate: '100', loyalty_min_redeem: '500',
  loyalty_max_redeem_pct: '30', loyalty_expiry_months: '12', loyalty_referral_referrer: '500',
  loyalty_referral_referee: '200', loyalty_earn_on_services: '1', loyalty_earn_on_products: '1',
  referral_referrer_credit: '200', referral_referee_discount: '100',
  msg_welcome: 'Hi {name}! Welcome to {salon_name} 🌸 We are so glad to have you.',
  msg_birthday: 'Happy Birthday {name}! 🎂🎉 The team at {salon_name} wishes you a fabulous day.',
  msg_anniversary: 'Happy Anniversary {name}! 💕 With love from the team at {salon_name}.',
};

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, multipleStatements: true, charset: 'utf8mb4',
  });
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await connection.query(schema);
  await connection.execute(
    `INSERT IGNORE INTO salons (name,slug,status,owner_name,owner_email,approved_at)
     VALUES (?,?, 'Active',?,?,NOW())`,
    [process.env.DEFAULT_SALON_NAME || 'Aura Salon Studio', process.env.DEFAULT_SALON_SLUG || 'aura',
      process.env.DEFAULT_SALON_OWNER || 'Owner', process.env.DEFAULT_SALON_EMAIL || 'owner@example.com'],
  );
  const [[defaultSalon]] = await connection.execute('SELECT id FROM salons WHERE slug=?', [process.env.DEFAULT_SALON_SLUG || 'aura']);
  const salonId = defaultSalon.id;
  const salonColumns=[['payment_status',"ENUM('Pending','Paid','Overdue','Waived') NOT NULL DEFAULT 'Pending' AFTER custom_domain"],['payment_notes','VARCHAR(500) NULL AFTER payment_status'],['access_starts_at','DATETIME NULL AFTER payment_notes'],['access_ends_at','DATETIME NULL AFTER access_starts_at']];
  for(const [column,definition] of salonColumns){const [found]=await connection.query(`SHOW COLUMNS FROM salons LIKE '${column}'`);if(!found.length)await connection.query(`ALTER TABLE salons ADD COLUMN ${column} ${definition}`);}
  const tenantTables = ['customers','sales','sale_items','capacity_pools','services','staff','service_staff','products','packages','expenses','users','audit_logs','settings','appointments','loyalty_transactions','referral_credit_transactions'];
  for (const table of tenantTables) {
    const [columns] = await connection.query(`SHOW COLUMNS FROM \`${table}\` LIKE 'salon_id'`);
    if (!columns.length) await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN salon_id INT UNSIGNED NULL ${['service_staff','settings'].includes(table)?'FIRST':'AFTER id'}`);
    await connection.execute(`UPDATE \`${table}\` SET salon_id=? WHERE salon_id IS NULL`, [salonId]);
    await connection.query(`ALTER TABLE \`${table}\` MODIFY salon_id INT UNSIGNED NOT NULL`);
  }
  const [settingsPrimary] = await connection.query("SHOW INDEX FROM settings WHERE Key_name='PRIMARY'");
  if (settingsPrimary.length === 1 && settingsPrimary[0].Column_name === 'key') {
    await connection.query('ALTER TABLE settings DROP PRIMARY KEY, ADD PRIMARY KEY (salon_id,`key`)');
  }
  const [discountNoteColumn] = await connection.query("SHOW COLUMNS FROM sales LIKE 'discount_note'");
  if (!discountNoteColumn.length) await connection.query('ALTER TABLE sales ADD COLUMN discount_note VARCHAR(255) NULL AFTER discount');
  await connection.query('ALTER TABLE sales MODIFY COLUMN payment_mode VARCHAR(120) NULL');
  const [capacityPoolColumn] = await connection.query("SHOW COLUMNS FROM services LIKE 'capacity_pool_id'");
  if (!capacityPoolColumn.length) await connection.query('ALTER TABLE services ADD COLUMN capacity_pool_id INT UNSIGNED NULL, ADD CONSTRAINT fk_service_capacity_pool FOREIGN KEY (capacity_pool_id) REFERENCES capacity_pools(id) ON DELETE SET NULL');
  const [groupTokenColumn] = await connection.query("SHOW COLUMNS FROM appointments LIKE 'group_token'");
  if (!groupTokenColumn.length) await connection.query('ALTER TABLE appointments ADD COLUMN group_token VARCHAR(64) NULL AFTER cancel_reason');
  const expenseColumns = [
    ['subcategory','VARCHAR(120) NULL AFTER category'], ['employee_name','VARCHAR(150) NULL AFTER subcategory'],
    ['expense_group','VARCHAR(64) NULL AFTER employee_name'], ['reference_no','VARCHAR(120) NULL AFTER paid_to'],
    ['period_start','DATE NULL AFTER reference_no'], ['period_end','DATE NULL AFTER period_start'], ['due_date','DATE NULL AFTER period_end'],
  ];
  for (const [column, definition] of expenseColumns) {
    const [found] = await connection.query(`SHOW COLUMNS FROM expenses LIKE '${column}'`);
    if (!found.length) await connection.query(`ALTER TABLE expenses ADD COLUMN ${column} ${definition}`);
  }
  const referralColumns = [
    ['customers','referral_credit','DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER referral_code'],
    ['sales','referrer_id','INT UNSIGNED NULL AFTER loyalty_discount'],
    ['sales','referral_discount','DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER referrer_id'],
    ['sales','referral_credit_used','DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER referral_discount'],
  ];
  for (const [table, column, definition] of referralColumns) {
    const [found] = await connection.query(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
    if (!found.length) await connection.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  const userColumns = [
    ['email','VARCHAR(190) NULL AFTER username'], ['staff_id','INT UNSIGNED NULL AFTER status'], ['permissions','JSON NULL AFTER staff_id'],
    ['force_password_change','TINYINT(1) NOT NULL DEFAULT 0 AFTER permissions'],
    ['last_login','DATETIME NULL AFTER force_password_change'], ['last_activity','DATETIME NULL AFTER last_login'],
    ['password_changed_at','DATETIME NULL AFTER last_activity'],
    ['created_by','INT UNSIGNED NULL AFTER last_activity'], ['created_at','TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER created_by'],
  ];
  for (const [column, definition] of userColumns) {
    const [found] = await connection.query(`SHOW COLUMNS FROM users LIKE '${column}'`);
    if (!found.length) await connection.query(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
  }
  await connection.query("UPDATE users SET role='owner' WHERE LOWER(role) IN ('owner','admin') AND id=(SELECT first_id FROM (SELECT MIN(id) first_id FROM users) first_user)");
  const [[{ count: poolCount }]] = await connection.execute('SELECT COUNT(*) AS count FROM capacity_pools WHERE salon_id=?',[salonId]);
  if (!poolCount) await connection.execute("INSERT INTO capacity_pools (salon_id,name,seats,is_default) VALUES (?,'General',1,1)",[salonId]);
  for (const [key, value] of Object.entries(defaults)) {
    await connection.execute('INSERT IGNORE INTO settings (salon_id,`key`,`value`) VALUES (?,?,?)', [salonId,key,value]);
  }
  await connection.query(`UPDATE users u
    JOIN (SELECT salon_id,MIN(id) id FROM users WHERE LOWER(role) IN ('owner','admin') GROUP BY salon_id) primary_user ON primary_user.id=u.id
    JOIN salons s ON s.id=u.salon_id
    SET u.email=s.owner_email
    WHERE u.email IS NULL OR u.email=''`);
  const [platformEmailColumn] = await connection.query("SHOW COLUMNS FROM platform_admins LIKE 'email'");
  if (!platformEmailColumn.length) await connection.query('ALTER TABLE platform_admins ADD COLUMN email VARCHAR(190) NULL UNIQUE AFTER username');
  await connection.query("ALTER TABLE platform_admins MODIFY status ENUM('Invited','Active','Inactive') NOT NULL DEFAULT 'Active'");
  const [[{ count: platformAdminCount }]] = await connection.query('SELECT COUNT(*) AS count FROM platform_admins');
  if (!platformAdminCount && process.env.INITIAL_PLATFORM_ADMIN_PASSWORD) {
    const platformHash = await bcrypt.hash(process.env.INITIAL_PLATFORM_ADMIN_PASSWORD, 12);
    await connection.execute(
      "INSERT INTO platform_admins (name,username,email,password_hash,status) VALUES (?,?,?,?,'Active')",
      [process.env.INITIAL_PLATFORM_ADMIN_NAME || 'Platform Admin', process.env.INITIAL_PLATFORM_ADMIN_USERNAME || 'platform-admin',process.env.INITIAL_PLATFORM_ADMIN_EMAIL||null,platformHash],
    );
  }
  if (process.env.PLATFORM_BOOTSTRAP_EMAIL) {
    const email=String(process.env.PLATFORM_BOOTSTRAP_EMAIL).trim().toLowerCase();
    const username=String(process.env.PLATFORM_BOOTSTRAP_USERNAME||'').trim().toLowerCase();
    const name=String(process.env.PLATFORM_BOOTSTRAP_NAME||'').trim();
    if (!/^\S+@\S+\.\S+$/.test(email) || !/^[a-z0-9._-]{3,40}$/.test(username) || !name) {
      throw new Error('PLATFORM_BOOTSTRAP_NAME, PLATFORM_BOOTSTRAP_USERNAME and PLATFORM_BOOTSTRAP_EMAIL must be valid.');
    }
    await connection.execute(`UPDATE platform_admins
      SET name=?,username=?,email=?
      WHERE id=(SELECT id FROM (SELECT MIN(id) id FROM platform_admins) bootstrap) AND (email IS NULL OR email='')`,[name,username,email]);
  }
  const [[{ count }]] = await connection.execute('SELECT COUNT(*) AS count FROM users WHERE salon_id=?',[salonId]);
  if (!count) {
    if (!process.env.INITIAL_ADMIN_PASSWORD) throw new Error('INITIAL_ADMIN_PASSWORD is required for the first admin account.');
    const passwordHash = await bcrypt.hash(process.env.INITIAL_ADMIN_PASSWORD, 12);
    await connection.execute(
      "INSERT INTO users (salon_id,name,username,email,password_hash,role,status) VALUES (?,'Admin','admin',?,?,'owner','Active')",
      [salonId,process.env.DEFAULT_SALON_EMAIL || 'owner@example.com',passwordHash],
    );
  }
  await connection.end();
  console.log('Database schema and default settings are ready.');
}

if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { main };
