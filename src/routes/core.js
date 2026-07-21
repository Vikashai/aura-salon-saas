'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { rateLimit } = require('express-rate-limit');
const db = require('../db');
const { asyncRoute, isoDate, firstName } = require('../helpers');
const { sendWhatsApp, sendEmail, sendPlatformEmail } = require('../notifications');
const { auth, loyaltyConfig, referralConfig, awardPoints, adjustReferralCredit, referralCode } = require('./shared');
const { audit } = require('../access');
const { money, calculateBaseTotals, applyRewards, paymentFromForm } = require('../billing-calculations');
const { generateInvoicePdf } = require('../invoice-pdf');

const CUSTOMER_FIELDS = ['name','mobile','alt_mobile','email','gender','dob','anniversary','address','city','state',
  'pincode','preferred_services','preferred_staff','preferred_products','care_notes','allergies','instructions',
  'tags','status','source','referred_by','notes','internal_notes'];

function arr(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function formArray(body, key) { return arr(body[key] ?? body[`${key}[]`]); }

function normalizeIndianMobile(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  return digits;
}

function addDays(date, offset) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function chartMoney(value) {
  const amount = Number(value || 0);
  if (amount >= 100000) return `₹${Math.round(amount / 1000)}k`;
  if (amount >= 1000) return `₹${Math.round(amount / 1000)}k`;
  return `₹${Math.round(amount)}`;
}

function salesChart(days, rows) {
  const byDate = new Map(rows.map(row => [String(row.invoice_date).slice(0, 10), Number(row.amount || 0)]));
  const values = days.map(date => ({ date, day: new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)), amount: byDate.get(date) || 0 }));
  const max = Math.max(...values.map(row => row.amount), 0);
  const scale = max > 0 ? Math.ceil(max / 5000) * 5000 : 5000;
  const points = values.map((row, index) => {
    const x = Math.round(index * (700 / Math.max(values.length - 1, 1)));
    const y = Math.round(200 - (row.amount / scale) * 170);
    return { ...row, x, y };
  });
  const line = points.map(point => `${point.x},${point.y}`).join(' ');
  const fill = points.length ? `M${points.map(point => `${point.x} ${point.y}`).join(' L')} L700 220 L0 220Z` : '';
  return { points, line, fill, labels: [scale, scale * .75, scale * .5, scale * .25, 0].map(chartMoney), total: values.reduce((sum, row) => sum + row.amount, 0) };
}

function publicDocument(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Aura POS</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f6f1;color:#20211f;font:15px/1.65 Arial,sans-serif}.wrap{width:min(860px,calc(100% - 32px));margin:44px auto;background:#fff;border:1px solid #e3e6df;border-radius:24px;padding:34px}a{color:#475044;font-weight:700}h1{font-size:30px;margin:0 0 10px}h2{margin:28px 0 8px;font-size:18px}p,li{color:#5f665d}.mark{width:38px;height:38px;border-radius:50%;background:#dfff3f;display:grid;place-items:center;margin-bottom:20px}.muted{color:#8a9087;font-size:13px}</style></head><body><main class="wrap"><div class="mark">✦</div>${body}<p class="muted">Last updated: July 2026</p></main></body></html>`;
}

module.exports = app => {
  app.get('/privacy',(req,res)=>res.send(publicDocument('Privacy Policy',`<h1>Privacy Policy</h1><p>Aura POS provides salon and point-of-sale software for appointments, billing, customer records, notifications, and business operations.</p><h2>Information we process</h2><ul><li>Salon account and staff login details, including name, email, role, and access status.</li><li>Customer records entered by salons, such as name, phone number, email, appointment, invoice, and loyalty details.</li><li>Communication metadata required to send email or WhatsApp notifications when enabled by the salon.</li></ul><h2>How we use information</h2><p>We use information to provide the Aura POS service, authenticate users, operate billing and booking workflows, send requested notifications, maintain security logs, and support the salon business.</p><h2>Sharing</h2><p>We do not sell personal information. We may process information through infrastructure, email, hosting, payment, or messaging providers only as needed to operate the service.</p><h2>Security and retention</h2><p>Access is role-based and salon data is scoped by workspace. Data is retained while a salon uses Aura POS or as required for legal, accounting, security, or operational reasons.</p><h2>Contact</h2><p>For privacy questions or deletion requests, contact the salon that collected your information or the Aura POS administrator managing the workspace.</p><p><a href="/">Back to Aura POS</a></p>`)));
  app.get('/terms',(req,res)=>res.send(publicDocument('Terms of Service',`<h1>Terms of Service</h1><p>These terms cover use of Aura POS, a salon point-of-sale and management platform.</p><h2>Use of service</h2><p>Salons are responsible for the accuracy of customer, appointment, invoice, tax, payment, and communication data entered into Aura POS.</p><h2>Accounts</h2><p>Users must keep login credentials secure and use the system only for authorized salon operations. Workspace owners are responsible for managing staff access.</p><h2>Messaging</h2><p>WhatsApp and email features must be used only for lawful customer communication with appropriate consent. Delivery depends on third-party providers and approved message templates where required.</p><h2>Availability</h2><p>We work to keep Aura POS reliable, but availability may depend on hosting, network, database, messaging, or other third-party services.</p><h2>Contact</h2><p>For commercial or support questions, contact the Aura POS administrator managing your workspace.</p><p><a href="/">Back to Aura POS</a></p>`)));
  app.get('/data-deletion',(req,res)=>res.send(publicDocument('Data Deletion',`<h1>Data Deletion Instructions</h1><p>If you want personal data removed from Aura POS, contact the salon that collected your information or the Aura POS administrator managing that salon workspace.</p><h2>What to include</h2><ul><li>Your name and contact number or email.</li><li>The salon/workspace connected to your request.</li><li>The data you want corrected, exported, or deleted.</li></ul><h2>What happens next</h2><p>The workspace administrator will verify the request and remove or anonymize data where legally and operationally permitted. Some invoice, tax, audit, security, or transaction records may need to be retained for compliance.</p><h2>Meta/Facebook data</h2><p>If your request relates to WhatsApp or Meta messaging data processed through Aura POS, include the phone number used for the conversation so the related records can be located.</p><p><a href="/">Back to Aura POS</a></p>`)));
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
    message: 'Too many login attempts. Please try again in 15 minutes.' });
  app.get('/login', (req, res) => req.session.user ? res.redirect('/dashboard') : res.render('login.html'));
  app.post('/login', loginLimiter, asyncRoute(async (req, res) => {
    const email = String(req.body.email || req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      req.flash('error', 'Enter the email address connected to your Aura account.');
      return res.redirect('/login');
    }
    const candidates = await db.platformRows(
      `SELECT u.*,s.slug salon_slug,s.status salon_status
       FROM users u JOIN salons s ON s.id=u.salon_id
       WHERE LOWER(u.email)=:email AND u.status='Active' AND s.status='Active'
         AND (s.access_starts_at IS NULL OR s.access_starts_at<=NOW())
         AND (s.access_ends_at IS NULL OR s.access_ends_at>=NOW())`,
      { email },
    );
    const matches=[];
    for (const candidate of candidates) {
      if (candidate.password_hash && await bcrypt.compare(password,candidate.password_hash)) matches.push(candidate);
    }
    const user=matches.length===1?matches[0]:null;
    if (user) {
      await new Promise((resolve,reject)=>req.session.regenerate(error=>error?reject(error):resolve()));
      req.session.user = { id:user.id,name:user.name,username:user.username,role:user.role,salon_id:user.salon_id,salon_slug:user.salon_slug,password_changed_at:user.password_changed_at||null };
      await db.rows('UPDATE users SET last_login=NOW(),last_activity=NOW() WHERE id=:id AND salon_id=:salonId',{id:user.id,salonId:user.salon_id});
      await audit(user.id,'auth.login','user',user.id,'Successful login',req);
      const target = req.session.returnTo || '/dashboard';
      delete req.session.returnTo;
      return res.redirect(target);
    }
    req.flash('error', 'Incorrect email or password.');
    return res.redirect('/login');
  }));
  const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false,
    message: 'Too many password reset attempts. Please try again in 15 minutes.' });
  app.get('/forgot-password',(req,res)=>res.render('forgot_password.html'));
  app.post('/forgot-password',resetLimiter,asyncRoute(async(req,res)=>{
    const email=String(req.body.email||'').trim().toLowerCase();
    if(!/^\S+@\S+\.\S+$/.test(email))return res.status(400).render('forgot_password.html',{email,error:'Enter a valid email address.'});
    const users=await db.platformRows(`SELECT u.id,u.salon_id,u.name,u.email,s.name salon_name
      FROM users u JOIN salons s ON s.id=u.salon_id
      WHERE LOWER(u.email)=? AND u.status='Active' AND s.status='Active'
        AND (s.access_starts_at IS NULL OR s.access_starts_at<=NOW())
        AND (s.access_ends_at IS NULL OR s.access_ends_at>=NOW())`,[email]);
    if(users.length===0)return res.status(404).render('forgot_password.html',{email,error:'No active Aura account was found for this email address.'});
    if(users.length>1)return res.status(409).render('forgot_password.html',{email,error:'More than one Aura account uses this email. Please contact support to clean up access.'});
    const user=users[0],otp=crypto.randomInt(0,1000000).toString().padStart(6,'0'),otpHash=crypto.createHash('sha256').update(otp).digest('hex');
    await db.rows('UPDATE password_reset_tokens SET used_at=NOW() WHERE salon_id=:salonId AND user_id=:userId AND used_at IS NULL',{salonId:user.salon_id,userId:user.id});
    await db.rows('INSERT INTO password_reset_tokens(salon_id,user_id,token_hash,expires_at) VALUES(:salonId,:userId,:otpHash,DATE_ADD(NOW(),INTERVAL 10 MINUTE))',{salonId:user.salon_id,userId:user.id,otpHash});
    try{await sendPlatformEmail(email,'Your Aura password reset code',`<p>Hello ${String(user.name||'').replace(/[<>&"']/g,'')},</p><p>Your Aura password reset code is:</p><p style="font-size:28px;font-weight:800;letter-spacing:6px">${otp}</p><p>This code expires in 10 minutes and works once. If you did not request it, ignore this email.</p>`);}catch(error){console.error('Password reset email failed:',error.message);}
    req.session.passwordResetEmail=email;
    req.flash('info','A six-digit code has been sent to that email address.');
    res.redirect('/reset-password');
  }));
  app.get('/reset-password',(req,res)=>res.render('reset_password.html',{email:req.session.passwordResetEmail||''}));
  app.post('/reset-password',resetLimiter,asyncRoute(async(req,res)=>{
    const email=String(req.body.email||req.session.passwordResetEmail||'').trim().toLowerCase(),otp=String(req.body.otp||'').replace(/\D/g,''),password=String(req.body.password||''),confirm=String(req.body.confirm_password||'');
    const otpHash=crypto.createHash('sha256').update(otp).digest('hex');
    const reset=otp.length===6?await db.platformOne(`SELECT t.id,t.salon_id,t.user_id FROM password_reset_tokens t JOIN users u ON u.id=t.user_id AND u.salon_id=t.salon_id WHERE LOWER(u.email)=? AND t.token_hash=? AND t.used_at IS NULL AND t.expires_at>NOW() AND u.status='Active'`,[email,otpHash]):null;
    if(!reset||password.length<8||password!==confirm){req.flash('error','The code is invalid or expired, or the passwords do not match.');return res.redirect('/reset-password');}
    const passwordHash=await bcrypt.hash(password,12);
    await db.transaction(async connection=>{
      await connection.execute('UPDATE users SET password_hash=?,force_password_change=0,password_changed_at=NOW() WHERE id=? AND salon_id=?',[passwordHash,reset.user_id,reset.salon_id]);
      await connection.execute('UPDATE password_reset_tokens SET used_at=NOW() WHERE id=? AND salon_id=?',[reset.id,reset.salon_id]);
    });
    delete req.session.passwordResetEmail;req.flash('success','Password reset successfully. You can sign in now.');res.redirect('/login');
  }));
  app.get('/logout', auth, (req, res) => req.session.destroy(() => res.redirect('/login')));
  app.get('/change-password',auth,(req,res)=>res.render('change_password.html'));
  app.post('/change-password',auth,asyncRoute(async(req,res)=>{const salonId=req.user.salon_id,user=await db.one('SELECT * FROM users WHERE id=:id AND salon_id=:salonId',{id:req.session.user.id,salonId}),current=String(req.body.current_password||''),password=String(req.body.new_password||''),confirm=String(req.body.confirm_password||'');if(!user||!await bcrypt.compare(current,user.password_hash)){req.flash('error','Current password is incorrect.');return res.redirect('/change-password');}if(password.length<8||password!==confirm){req.flash('error','New passwords must match and contain at least 8 characters.');return res.redirect('/change-password');}const hash=await bcrypt.hash(password,12);await db.rows('UPDATE users SET password_hash=:hash,force_password_change=0 WHERE id=:id AND salon_id=:salonId',{hash,id:user.id,salonId});await audit(user.id,'auth.password_changed','user',user.id,'Password changed',req);req.flash('success','Password changed successfully.');res.redirect('/dashboard');}));

  app.get('/',(req,res)=>res.render('landing.html'));
  app.get('/dashboard', auth, asyncRoute(async (req, res) => {
    const today = isoDate();
    const salonId=req.user.salon_id;
    const month = today.slice(0, 7);
    const monthStart = `${month}-01`;
    const stats = {
      today: (await db.one('SELECT COALESCE(SUM(final_amount),0) value FROM sales WHERE salon_id=:salonId AND invoice_date=:today AND cancelled=0', {salonId,today})).value,
      month: (await db.one('SELECT COALESCE(SUM(final_amount),0) value FROM sales WHERE salon_id=:salonId AND invoice_date>=:monthStart AND invoice_date<DATE_ADD(:monthStart,INTERVAL 1 MONTH) AND cancelled=0', {salonId,monthStart})).value,
      customers: (await db.one('SELECT COUNT(*) value FROM customers WHERE salon_id=:salonId AND archived=0',{salonId})).value,
      new: (await db.one('SELECT COUNT(*) value FROM customers WHERE salon_id=:salonId AND created_at>=:monthStart AND created_at<DATE_ADD(:monthStart,INTERVAL 1 MONTH)', {salonId,monthStart})).value,
      pending: (await db.one('SELECT COALESCE(SUM(pending_amount),0) value FROM sales WHERE salon_id=:salonId AND cancelled=0',{salonId})).value,
      appts_today: (await db.one("SELECT COUNT(*) value FROM appointments WHERE salon_id=:salonId AND appointment_date=:today AND status NOT IN ('cancelled','no_show')", {salonId,today})).value,
    };
    const chartDays = Array.from({ length: 7 }, (_, index) => addDays(today, index - 6));
    const [recent, customers, low, top_services, upcoming, chartRows] = await Promise.all([
      db.rows('SELECT s.*,c.name customer FROM sales s LEFT JOIN customers c ON c.id=s.customer_id AND c.salon_id=s.salon_id WHERE s.salon_id=:salonId ORDER BY s.id DESC LIMIT 5',{salonId}),
      db.rows('SELECT * FROM customers WHERE salon_id=:salonId AND archived=0 ORDER BY id DESC LIMIT 5',{salonId}),
      db.rows('SELECT * FROM products WHERE salon_id=:salonId AND archived=0 AND stock<=low_stock ORDER BY stock LIMIT 4',{salonId}),
      db.rows("SELECT item_name,COUNT(*) qty,SUM(price*quantity-discount) amount FROM sale_items WHERE salon_id=:salonId AND item_type='Service' GROUP BY item_name ORDER BY amount DESC LIMIT 4",{salonId}),
      db.rows("SELECT * FROM appointments WHERE salon_id=:salonId AND appointment_date>=:today AND status IN ('pending','confirmed') ORDER BY appointment_date,appointment_time LIMIT 5", {salonId,today}),
      db.rows('SELECT invoice_date,COALESCE(SUM(final_amount),0) amount FROM sales WHERE salon_id=:salonId AND cancelled=0 AND invoice_date>=:chartStart AND invoice_date<=:today GROUP BY invoice_date ORDER BY invoice_date',{salonId,chartStart:chartDays[0],today}),
    ]);
    res.render('dashboard.html', { stats, recent, customers, low, top_services, upcoming,
      sales_chart: salesChart(chartDays, chartRows),
      today, today_day: new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date()) });
  }));

  app.get('/customers', auth, asyncRoute(async (req, res) => {
    const q = String(req.query.q || '');
    const like = `%${q}%`;
    const rows = await db.rows(
      `SELECT c.*,COALESCE(SUM(s.final_amount),0) spent,COUNT(s.id) visits,MAX(s.invoice_date) last_visit
       FROM customers c LEFT JOIN sales s ON s.customer_id=c.id AND s.salon_id=c.salon_id AND s.cancelled=0
       WHERE c.salon_id=:salonId AND c.archived=0 AND (c.name LIKE :like OR c.mobile LIKE :like OR c.email LIKE :like OR c.customer_id LIKE :like)
       GROUP BY c.id ORDER BY c.id DESC`, {salonId:req.user.salon_id,like});
    res.render('customers.html', { rows, q });
  }));
  app.get('/customers/lookup', auth, asyncRoute(async(req,res)=>{
    const q=String(req.query.q||'').trim();
    const digits=normalizeIndianMobile(q);
    if(q.length<3&&digits.length<3)return res.json({matches:[]});
    const params={salonId:req.user.salon_id,like:`%${q}%`,digits,digitsLike:`%${digits}%`};
    const rows=await db.rows(`SELECT id,customer_id,name,mobile,alt_mobile,email,gender,dob,anniversary,source,tags,care_notes,notes,internal_notes
      FROM customers
      WHERE salon_id=:salonId AND archived=0 AND (
        name LIKE :like OR email LIKE :like OR customer_id LIKE :like
        OR (:digits<>'' AND (mobile LIKE :digitsLike OR alt_mobile LIKE :digitsLike))
      )
      ORDER BY CASE
        WHEN :digits<>'' AND (mobile=:digits OR alt_mobile=:digits) THEN 0
        WHEN :digits<>'' AND (mobile LIKE :digitsLike OR alt_mobile LIKE :digitsLike) THEN 1
        ELSE 2 END, id DESC
      LIMIT 8`,params);
    res.json({matches:rows});
  }));

  const customerForm = async (req, res) => {
    const cid = req.params.cid ? Number(req.params.cid) : null;
    const salonId=req.user.salon_id;
    if (req.method === 'POST') {
      const values = Object.fromEntries(CUSTOMER_FIELDS.map(field => [field, req.body[field] || null]));
      values.mobile = normalizeIndianMobile(values.mobile);
      values.alt_mobile = normalizeIndianMobile(values.alt_mobile) || null;
      values.email = String(values.email || '').trim().toLowerCase() || null;
      if (!values.mobile) {
        req.flash('error', 'WhatsApp mobile number is required.');
        return res.redirect(cid ? `/customers/${cid}/edit` : '/customers/new');
      }
      if (values.email && !/^\S+@\S+\.\S+$/.test(values.email)) {
        req.flash('error', 'Enter a valid email address or leave it blank.');
        return res.redirect(cid ? `/customers/${cid}/edit` : '/customers/new');
      }
      if (!/^\d{10}$/.test(values.mobile) || (values.alt_mobile && !/^\d{10}$/.test(values.alt_mobile))) {
        req.flash('error', 'Enter a valid 10-digit mobile number.');
        return res.redirect(cid ? `/customers/${cid}/edit` : '/customers/new');
      }
      if (values.alt_mobile && values.alt_mobile === values.mobile) {
        req.flash('error', 'Primary and alternate mobile numbers must be different.');
        return res.redirect(cid ? `/customers/${cid}/edit` : '/customers/new');
      }
      const duplicateNumber = await db.one(`SELECT id,name FROM customers
        WHERE salon_id=:salonId AND id<>COALESCE(:cid,0)
          AND (mobile=:mobile OR alt_mobile=:mobile OR (:altMobile IS NOT NULL AND (mobile=:altMobile OR alt_mobile=:altMobile)))
        LIMIT 1`,{salonId,cid,mobile:values.mobile,altMobile:values.alt_mobile});
      if (duplicateNumber) {
        req.flash('error', `That contact number already belongs to ${duplicateNumber.name}. Open existing customer #${duplicateNumber.id} instead of creating a duplicate.`);
        return res.redirect(cid ? `/customers/${cid}/edit` : '/customers/new');
      }
      if (values.email) {
        const duplicateEmail=await db.one(`SELECT id,name FROM customers WHERE salon_id=:salonId AND id<>COALESCE(:cid,0) AND LOWER(email)=LOWER(:email) LIMIT 1`,{salonId,cid,email:values.email});
        if(duplicateEmail){req.flash('error',`That email address already belongs to ${duplicateEmail.name}. Open existing customer #${duplicateEmail.id} instead of creating a duplicate.`);return res.redirect(cid ? `/customers/${cid}/edit` : '/customers/new');}
      }
      for (const dateField of ['dob', 'anniversary']) if (!values[dateField]) values[dateField] = null;
      const referredById = req.body.referred_by_id || null;
      if (cid) {
        const assignments = CUSTOMER_FIELDS.map(field => `\`${field}\`=:${field}`).join(',');
        await db.rows(`UPDATE customers SET ${assignments},referred_by_id=:referredById WHERE id=:cid AND salon_id=:salonId`, { ...values,referredById,cid,salonId });
      } else {
        const next = await db.one('SELECT COALESCE(MAX(id),0)+1001 next_id FROM customers WHERE salon_id=:salonId',{salonId});
        const code = await referralCode(salonId);
        const columns = CUSTOMER_FIELDS.map(field => `\`${field}\``).join(',');
        const params = CUSTOMER_FIELDS.map(field => `:${field}`).join(',');
        await db.rows(`INSERT INTO customers(salon_id,customer_id,referral_code,referred_by_id,${columns}) VALUES(:salonId,:customerId,:code,:referredById,${params})`,
          { ...values,salonId,customerId:`CUS-${next.next_id}`,code,referredById });
        const template = req.settings.msg_welcome || '';
        if (template && values.mobile) {
          const first = firstName(values.name);
          const salon = req.settings.salon_name || 'our salon';
          const message = template.replaceAll('{name}', first).replaceAll('{salon_name}', salon);
          const result = await sendWhatsApp(req.settings, values.mobile, message,
            req.settings.meta_template_welcome || null, [first, salon]);
          if (!result.ok) req.flash('error', `WhatsApp welcome failed: ${result.message}`);
        }
      }
      req.flash('success', 'Customer saved successfully.');
      return res.redirect('/customers');
    }
    const row = cid ? await db.one('SELECT * FROM customers WHERE id=:cid AND salon_id=:salonId',{cid,salonId}) : null;
    const all_customers = await db.rows('SELECT id,name,mobile FROM customers WHERE salon_id=:salonId AND archived=0 AND id!=COALESCE(:cid,0) ORDER BY name',{cid,salonId});
    return res.render('customer_form.html', { row, all_customers });
  };
  app.get('/customers/new', auth, asyncRoute(customerForm));
  app.post('/customers/new', auth, asyncRoute(customerForm));
  app.get('/customers/:cid/edit', auth, asyncRoute(customerForm));
  app.post('/customers/:cid/edit', auth, asyncRoute(customerForm));

  app.get('/customers/:cid', auth, asyncRoute(async (req, res) => {
    const cid=Number(req.params.cid),salonId=req.user.salon_id;
    const [row, bills, appts, loyalty_txns, referral_txns] = await Promise.all([
      db.one('SELECT c.*,r.name referrer_name,COALESCE(c.referred_by,r.name) referred_by FROM customers c LEFT JOIN customers r ON r.id=c.referred_by_id AND r.salon_id=c.salon_id WHERE c.id=:cid AND c.salon_id=:salonId',{cid,salonId}),
      db.rows('SELECT * FROM sales WHERE salon_id=:salonId AND customer_id=:cid ORDER BY invoice_date DESC',{cid,salonId}),
      db.rows('SELECT * FROM appointments WHERE salon_id=:salonId AND customer_id=:cid ORDER BY appointment_date DESC LIMIT 10',{cid,salonId}),
      db.rows('SELECT * FROM loyalty_transactions WHERE salon_id=:salonId AND customer_id=:cid ORDER BY id DESC LIMIT 30',{cid,salonId}),
      db.rows('SELECT * FROM referral_credit_transactions WHERE salon_id=:salonId AND customer_id=:cid ORDER BY id DESC LIMIT 30',{cid,salonId}),
    ]);
    if (!row) return res.status(404).send('Customer not found');
    const active = bills.filter(bill => !bill.cancelled);
    res.render('customer_profile.html', { row, bills, appts, loyalty_txns, referral_txns,
      spent: active.reduce((sum, bill) => sum + Number(bill.final_amount), 0),
      pending: active.reduce((sum, bill) => sum + Number(bill.pending_amount), 0),
      loyalty_balance: Number(row.loyalty_points || 0), loyalty_cfg: loyaltyConfig(req.settings) });
  }));
  app.post('/customers/:cid/archive', auth, asyncRoute(async (req, res) => {
    await db.rows('UPDATE customers SET archived=1 WHERE id=:cid AND salon_id=:salonId',{cid:Number(req.params.cid),salonId:req.user.salon_id});
    req.flash('success', 'Customer archived.'); res.redirect('/customers');
  }));

  app.get('/billing', auth, asyncRoute(async (req, res) => {
    const rows=await db.rows('SELECT s.*,c.name customer FROM sales s LEFT JOIN customers c ON c.id=s.customer_id AND c.salon_id=s.salon_id WHERE s.salon_id=:salonId ORDER BY s.invoice_date DESC,s.id DESC',{salonId:req.user.salon_id});
    const activeRows = rows.filter(row => !row.cancelled);
    const salesTotal = activeRows.reduce((sum, row) => sum + Number(row.final_amount || 0), 0);
    const outstandingTotal = activeRows.reduce((sum, row) => sum + Number(row.pending_amount || 0), 0);
    res.render('billing.html', { rows, salesTotal, outstandingTotal });
  }));
  app.get('/billing/new', auth, asyncRoute(async (req, res) => {
    const salonId=req.user.salon_id;
    const [customers, staff, services, products, packages] = await Promise.all([
      db.rows('SELECT * FROM customers WHERE salon_id=:salonId AND archived=0 ORDER BY name',{salonId}),
      db.rows("SELECT * FROM staff WHERE salon_id=:salonId AND archived=0 AND status='Active'",{salonId}),
      db.rows("SELECT s.id,s.name,s.category,s.price,GROUP_CONCAT(ss.staff_id ORDER BY ss.staff_id) staff_ids FROM services s LEFT JOIN service_staff ss ON ss.service_id=s.id AND ss.salon_id=s.salon_id WHERE s.salon_id=:salonId AND s.archived=0 AND s.status='Active' GROUP BY s.id ORDER BY s.category,s.name",{salonId}),
      db.rows("SELECT id,name,category,brand,selling_price price FROM products WHERE salon_id=:salonId AND archived=0 AND status='Active' ORDER BY category,name",{salonId}),
      db.rows("SELECT id,name,kind category,price FROM packages WHERE salon_id=:salonId AND archived=0 AND status='Active' ORDER BY kind,name",{salonId}),
    ]);
    res.render('bill_form.html', { customers, staff, services, products, packages, loyalty_cfg: loyaltyConfig(req.settings), referral_cfg: referralConfig(req.settings) });
  }));
  app.post('/billing/new', auth, asyncRoute(async (req, res) => {
    const salonId=req.user.salon_id;
    const cfg = loyaltyConfig(req.settings);
    const referralCfg = referralConfig(req.settings);
    const customerId = req.body.customer_id ? Number(req.body.customer_id) : null;
    const customerData=customerId?await db.one('SELECT referral_credit,referred_by_id FROM customers WHERE id=:customerId AND salon_id=:salonId',{customerId,salonId}):null;
    if(customerId&&!customerData)return res.status(400).send('Invalid customer');
    const priorBillCount=customerId?Number((await db.one('SELECT COUNT(*) count FROM sales WHERE salon_id=:salonId AND customer_id=:customerId AND cancelled=0',{customerId,salonId})).count):0;
    const itemIds = formArray(req.body,'item_id'), names = formArray(req.body,'item_name'), types = formArray(req.body,'item_type'), quantities = formArray(req.body,'quantity'), staffNames = formArray(req.body,'staff_name'), staffIds = formArray(req.body,'staff_id');
    const catalog = { Service:['services','price'], Product:['products','selling_price'], Package:['packages','price'], Membership:['packages','price'] };
    const normalizedLines = [];
    for (let index = 0; index < names.length; index++) {
      const type = types[index], definition = catalog[type], itemId = Number(itemIds[index] || 0), name = String(names[index] || '').trim();
      if (!definition || !name) continue;
      const item = itemId
        ? await db.one(`SELECT name,\`${definition[1]}\` price FROM \`${definition[0]}\` WHERE salon_id=:salonId AND id=:itemId AND archived=0 AND status='Active' LIMIT 1`,{itemId,salonId})
        : await db.one(`SELECT name,\`${definition[1]}\` price FROM \`${definition[0]}\` WHERE salon_id=:salonId AND name=:name AND archived=0 AND status='Active' LIMIT 1`,{name,salonId});
      if (!item) continue;
      const quantity=Number(quantities[index] ?? 1),price=Number(item.price||0);
      if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(price)||price<0)continue;
      const staffId=Number(staffIds[index]||0),staff=staffId?await db.one('SELECT id,name FROM staff WHERE id=:staffId AND salon_id=:salonId AND archived=0 AND status=\'Active\'',{staffId,salonId}):null;
      normalizedLines.push({ type, name:item.name, quantity, price, staff_id:staff?.id||null, staff:staff?.name||staffNames[index]||null });
    }
    if (!normalizedLines.length) { req.flash('error', 'Select at least one valid service, product, package or combo service.'); return res.redirect('/billing/new'); }
    const subtotal = money(normalizedLines.reduce((sum,line)=>sum+line.quantity*line.price,0)), requestedDiscount = Number(req.body.discount || 0);
    const discountNote = String(req.body.discount_note || '').trim();
    if (requestedDiscount > 0 && !discountNote) { req.flash('error', 'Enter a reason for the discount.'); return res.redirect('/billing/new'); }
    const gst = req.body.gst_enabled ? 1 : 0,base=calculateBaseTotals({subtotal,discount:requestedDiscount,gstEnabled:Boolean(gst),gstPercent:req.body.gst_percent});
    const {discount,gstPercent,tax,beforeRewards:beforeLoyalty}=base;
    let pointsUsed = Number.parseInt(req.body.loyalty_points_used || 0, 10), loyaltyDiscount = 0;
    if (pointsUsed > 0 && customerId && cfg.enabled) {
      const customer=await db.one('SELECT loyalty_points FROM customers WHERE id=:customerId AND salon_id=:salonId',{customerId,salonId});
      pointsUsed = Math.min(pointsUsed, Number(customer?.loyalty_points || 0));
      loyaltyDiscount = Math.min(pointsUsed / cfg.redeem_rate, beforeLoyalty * cfg.max_redeem_pct / 100);
      loyaltyDiscount = Math.round(loyaltyDiscount * 100) / 100;
      pointsUsed = Math.floor(loyaltyDiscount * cfg.redeem_rate);
    } else pointsUsed = 0;
    let referrerId = !priorBillCount ? Number(req.body.referrer_id || customerData?.referred_by_id || 0) : 0;
    if(referrerId===customerId||(referrerId&&!await db.one('SELECT id FROM customers WHERE id=:referrerId AND salon_id=:salonId AND archived=0',{referrerId,salonId})))referrerId=0;
    const requestedReferralDiscount = referrerId ? referralCfg.referee_discount : 0;
    const requestedCredit = Math.max(Number(req.body.referral_credit_used || 0),0);
    const requestedReferralCredit = Math.min(requestedCredit,Number(customerData?.referral_credit||0));
    const rewards=applyRewards(beforeLoyalty,loyaltyDiscount,requestedReferralDiscount,requestedReferralCredit);
    loyaltyDiscount=rewards.loyaltyDiscount;const {referralDiscount,referralCreditUsed,finalAmount}=rewards;
    const payment = paymentFromForm(req.body, finalAmount);
    if (payment.error) { req.flash('error', payment.error); return res.redirect('/billing/new'); }
    const { paid, mode: paymentMode } = payment;
    const pending = Math.max(Math.round((finalAmount - paid) * 100) / 100, 0);
    const paymentStatus = pending === 0 ? 'Paid' : paid ? 'Partially Paid' : 'Pending';
    const invoiceNo = `INV-${new Date().toISOString().replace(/\D/g, '').slice(2, 14)}`;
    const result = await db.transaction(async connection => {
      const [sale] = await connection.execute(
        `INSERT INTO sales(salon_id,invoice_no,customer_id,invoice_date,subtotal,discount,discount_note,gst_enabled,gst_percent,tax_amount,
         final_amount,paid_amount,pending_amount,payment_mode,payment_status,notes,internal_notes,loyalty_points_used,loyalty_discount,referrer_id,referral_discount,referral_credit_used)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [salonId,invoiceNo,customerId,req.body.invoice_date,subtotal,discount,discountNote||null,gst,gstPercent,tax,finalAmount,paid,
          pending, paymentMode, paymentStatus, req.body.notes || null, req.body.internal_notes || null, pointsUsed, loyaltyDiscount,referrerId||null,referralDiscount,referralCreditUsed]);
      for (const line of normalizedLines) {
        await connection.execute('INSERT INTO sale_items(salon_id,sale_id,item_type,item_name,quantity,price,discount,staff_id,staff_name) VALUES(?,?,?,?,?,?,?,?,?)',
          [salonId,sale.insertId,line.type,line.name,line.quantity,line.price,0,line.staff_id,line.staff]);
      }
      if (customerId && cfg.enabled) {
        if(pointsUsed)await awardPoints(connection,salonId,customerId,-pointsUsed,'redeem',`Redeemed on ${invoiceNo} (₹${loyaltyDiscount.toFixed(0)} off)`,'sale',sale.insertId);
        const eligibleSubtotal=normalizedLines.reduce((sum,line)=>sum+((line.type==='Service'&&cfg.earn_services)||(line.type==='Product'&&cfg.earn_products)?line.quantity*line.price:0),0);
        const earnedBase=subtotal>0?finalAmount*Math.min(eligibleSubtotal/subtotal,1):0;
        const earned = Math.floor(earnedBase * cfg.earn_rate);
        if (earned) {
          await awardPoints(connection,salonId,customerId,earned,'earn',`Earned on ${invoiceNo}`,'sale',sale.insertId);
          await connection.execute('UPDATE sales SET loyalty_points_earned=? WHERE id=? AND salon_id=?',[earned,sale.insertId,salonId]);
        }
      }
      if(customerId&&referralCreditUsed)await adjustReferralCredit(connection,salonId,customerId,-referralCreditUsed,'redeem',`Used on ${invoiceNo}`,null,sale.insertId);
      if (customerId && referrerId && !priorBillCount) {
        await connection.execute("UPDATE customers SET referred_by_id=?,source='Referral' WHERE id=? AND salon_id=?",[referrerId,customerId,salonId]);
        if(paid>0&&referralCfg.referrer_credit>0)await adjustReferralCredit(connection,salonId,referrerId,referralCfg.referrer_credit,'earn',`Referral reward for ${invoiceNo}`,customerId,sale.insertId);
      }
      return sale.insertId;
    });
    if(String(req.settings.whatsapp_invoice_live||'0')==='1'&&String(req.settings.billing_auto_whatsapp||'0')==='1'&&String(req.settings.meta_template_invoice||'').trim()&&customerId){
      const customer=await db.one('SELECT name,mobile FROM customers WHERE id=:customerId AND salon_id=:salonId',{customerId,salonId});
      const template=String(req.settings.meta_template_invoice||'').trim();
      if(customer?.mobile){
        const salon=req.settings.salon_name||'Aura Salon';
        const parameters=[customer.name||'Customer',invoiceNo,salon,`Rs ${Number(finalAmount).toLocaleString('en-IN')}`,`Rs ${Number(paid).toLocaleString('en-IN')}`,`Rs ${Number(pending).toLocaleString('en-IN')}`,req.body.invoice_date];
        const message=`Invoice ${invoiceNo} from ${salon}. Total: ${parameters[3]}; Paid: ${parameters[4]}; Balance: ${parameters[5]}.`;
        const sent=await sendWhatsApp(req.settings,customer.mobile,message,template,parameters);
        if(!sent.ok)req.flash('error',`Invoice WhatsApp failed: ${sent.message}`);
      }
    }
    if(String(req.settings.billing_auto_email||'0')==='1'&&customerId){
      const customer=await db.one('SELECT name,mobile,email,address,city,state FROM customers WHERE id=:customerId AND salon_id=:salonId',{customerId,salonId});
      if(customer?.email){
        const salon=req.settings.salon_name||'Aura Salon',sale={id:result,invoice_no:invoiceNo,invoice_date:req.body.invoice_date,customer:customer.name,mobile:customer.mobile,email:customer.email,address:customer.address,city:customer.city,state:customer.state,payment_mode:paymentMode,payment_status:paymentStatus,subtotal,discount,gst_enabled:gst,gst_percent:gstPercent,tax_amount:tax,final_amount:finalAmount,paid_amount:paid,pending_amount:pending,notes:req.body.notes||null};
        const pdfItems=normalizedLines.map(line=>({item_name:line.name,item_type:line.type,quantity:line.quantity,price:line.price,discount:0,staff_name:line.staff}));
        try{const pdf=await generateInvoicePdf(sale,pdfItems,req.settings),sent=await sendEmail(req.settings,customer.email,`${invoiceNo} from ${salon}`,`<p>Hi ${customer.name||'Customer'},</p><p>Thank you for visiting ${salon}. Your invoice is attached as a PDF.</p>`,[{filename:`${invoiceNo}.pdf`,content:pdf,contentType:'application/pdf'}]);if(!sent.ok)req.flash('error',`Invoice email failed: ${sent.message}`);}catch(error){req.flash('error',`Invoice email failed: ${error.message}`);}
      }
    }
    req.flash('success', `${invoiceNo} created successfully.`);
    res.redirect(`/billing/${result}`);
  }));
  app.get('/billing/:sid', auth, asyncRoute(async (req, res) => {
    const sid=Number(req.params.sid),salonId=req.user.salon_id;
    const [sale, items] = await Promise.all([
      db.one('SELECT s.*,c.name customer,c.mobile,c.email,c.address,c.city,c.state FROM sales s LEFT JOIN customers c ON c.id=s.customer_id AND c.salon_id=s.salon_id WHERE s.id=:sid AND s.salon_id=:salonId',{sid,salonId}),
      db.rows('SELECT * FROM sale_items WHERE sale_id=:sid AND salon_id=:salonId',{sid,salonId}),
    ]);
    if (!sale) return res.status(404).send('Invoice not found');
    let whatsappNumber=String(sale.mobile||'').replace(/\D/g,'');
    if(whatsappNumber.length===10)whatsappNumber=`91${whatsappNumber}`;
    if(whatsappNumber.length>=8&&whatsappNumber.length<=15){
      const salon=req.settings.salon_name||'Aura Salon';
      const message=[
        `Hi ${sale.customer||'Customer'},`,
        `Your invoice ${sale.invoice_no} from ${salon} is ready.`,
        `Total: Rs ${Number(sale.final_amount||0).toLocaleString('en-IN')}`,
        `Paid: Rs ${Number(sale.paid_amount||0).toLocaleString('en-IN')}`,
        `Balance: Rs ${Number(sale.pending_amount||0).toLocaleString('en-IN')}`,
        'Thank you for visiting us.'
      ].join('\n');
      sale.whatsapp_manual_url=`https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;
    }
    res.render('invoice.html', { sale, items, settings: req.settings });
  }));
  app.get('/billing/:sid/pdf',auth,asyncRoute(async(req,res)=>{
    const sid=Number(req.params.sid),salonId=req.user.salon_id,[sale,items]=await Promise.all([db.one('SELECT s.*,c.name customer,c.mobile,c.email,c.address,c.city,c.state FROM sales s LEFT JOIN customers c ON c.id=s.customer_id AND c.salon_id=s.salon_id WHERE s.id=:sid AND s.salon_id=:salonId',{sid,salonId}),db.rows('SELECT * FROM sale_items WHERE sale_id=:sid AND salon_id=:salonId',{sid,salonId})]);
    if(!sale)return res.status(404).send('Invoice not found');
    const pdf=await generateInvoicePdf(sale,items,req.settings);res.type('application/pdf').attachment(`${sale.invoice_no}.pdf`).send(pdf);
  }));
  app.get('/billing/:sid/whatsapp',auth,asyncRoute(async(req,res)=>{
    const sid=Number(req.params.sid),salonId=req.user.salon_id,sale=await db.one('SELECT s.*,c.name customer,c.mobile FROM sales s LEFT JOIN customers c ON c.id=s.customer_id AND c.salon_id=s.salon_id WHERE s.id=:sid AND s.salon_id=:salonId',{sid,salonId});
    if(!sale)return res.status(404).send('Invoice not found');
    let number=String(sale.mobile||'').replace(/\D/g,'');
    if(number.length===10)number=`91${number}`;
    if(number.length<8||number.length>15){req.flash('error','Add a valid customer WhatsApp mobile number before opening WhatsApp.');return res.redirect(`/billing/${sid}`);}
    const salon=req.settings.salon_name||'Aura Salon';
    const message=[
      `Hi ${sale.customer||'Customer'},`,
      `Your invoice ${sale.invoice_no} from ${salon} is ready.`,
      `Total: Rs ${Number(sale.final_amount||0).toLocaleString('en-IN')}`,
      `Paid: Rs ${Number(sale.paid_amount||0).toLocaleString('en-IN')}`,
      `Balance: Rs ${Number(sale.pending_amount||0).toLocaleString('en-IN')}`,
      'Thank you for visiting us.'
    ].join('\n');
    res.redirect(`https://wa.me/${number}?text=${encodeURIComponent(message)}`);
  }));
  app.get('/billing/:sid/edit', auth, asyncRoute(async(req,res)=>{
    const sid=Number(req.params.sid),salonId=req.user.salon_id,sale=await db.one('SELECT s.*,c.name customer FROM sales s LEFT JOIN customers c ON c.id=s.customer_id AND c.salon_id=s.salon_id WHERE s.id=:sid AND s.salon_id=:salonId',{sid,salonId});
    if(!sale)return res.status(404).send('Invoice not found');
    res.render('invoice_edit.html',{sale});
  }));
  app.post('/billing/:sid/edit', auth, asyncRoute(async(req,res)=>{
    const sid=Number(req.params.sid),salonId=req.user.salon_id,sale=await db.one('SELECT * FROM sales WHERE id=:sid AND salon_id=:salonId',{sid,salonId});if(!sale)return res.status(404).send('Invoice not found');
    const requestedDiscount=Math.max(Number(req.body.discount||0),0),discountNote=String(req.body.discount_note||'').trim();
    if(requestedDiscount>0&&!discountNote){req.flash('error','Enter a reason for the discount.');return res.redirect(`/billing/${sid}/edit`);}
    const gst=req.body.gst_enabled?1:0,base=calculateBaseTotals({subtotal:sale.subtotal,discount:requestedDiscount,gstEnabled:Boolean(gst),gstPercent:req.body.gst_percent}),rewards=applyRewards(base.beforeRewards,sale.loyalty_discount,sale.referral_discount,sale.referral_credit_used),{discount,gstPercent,tax}=base,{finalAmount}=rewards;
    const payment=paymentFromForm({paid_amount:req.body.paid_amount,payment_mode:req.body.payment_mode},finalAmount);if(payment.error){req.flash('error',payment.error);return res.redirect(`/billing/${sid}/edit`);}const {paid}=payment,pending=money(finalAmount-paid),status=pending===0?'Paid':paid>0?'Partially Paid':'Pending';
    await db.rows('UPDATE sales SET invoice_date=:invoiceDate,discount=:discount,discount_note=:discountNote,gst_enabled=:gst,gst_percent=:gstPercent,tax_amount=:tax,final_amount=:finalAmount,paid_amount=:paid,pending_amount=:pending,payment_mode=:paymentMode,payment_status=:status,notes=:notes,internal_notes=:internalNotes WHERE id=:sid AND salon_id=:salonId',{invoiceDate:req.body.invoice_date,discount,discountNote:discountNote||null,gst,gstPercent,tax,finalAmount,paid,pending,paymentMode:req.body.payment_mode,status,notes:req.body.notes||null,internalNotes:req.body.internal_notes||null,sid,salonId});
    if(Number(sale.paid_amount||0)<=0&&paid>0&&sale.referrer_id){const existing=await db.one("SELECT id FROM referral_credit_transactions WHERE salon_id=:salonId AND sale_id=:sid AND type='earn'",{sid,salonId});const reward=referralConfig(req.settings).referrer_credit;if(!existing&&reward>0)await db.transaction(connection=>adjustReferralCredit(connection,salonId,sale.referrer_id,reward,'earn',`Referral reward for ${sale.invoice_no}`,sale.customer_id,sid));}
    req.flash('success',`${sale.invoice_no} updated.`);res.redirect(`/billing/${sid}`);
  }));
  app.post('/billing/:sid/send/:channel', auth, asyncRoute(async(req,res)=>{
    const sid=Number(req.params.sid),salonId=req.user.salon_id,channel=req.params.channel,[sale,items]=await Promise.all([db.one('SELECT s.*,c.name customer,c.mobile,c.email FROM sales s LEFT JOIN customers c ON c.id=s.customer_id AND c.salon_id=s.salon_id WHERE s.id=:sid AND s.salon_id=:salonId',{sid,salonId}),db.rows('SELECT * FROM sale_items WHERE sale_id=:sid AND salon_id=:salonId',{sid,salonId})]);
    if(!sale)return res.status(404).send('Invoice not found');
    const salon=req.settings.salon_name||'Aura Salon',itemText=items.map(item=>`${item.item_name} x ${Number(item.quantity)} - ₹${(Number(item.quantity)*Number(item.price)).toLocaleString('en-IN')}`).join('\n');
    const message=`Hi ${sale.customer||'Customer'},\n\nInvoice ${sale.invoice_no} from ${salon}\n${itemText}\n\nTotal: ₹${Number(sale.final_amount).toLocaleString('en-IN')}\nPaid: ₹${Number(sale.paid_amount).toLocaleString('en-IN')}\nBalance: ₹${Number(sale.pending_amount).toLocaleString('en-IN')}\nDate: ${sale.invoice_date}\n\nThank you for visiting ${salon}.`;
    const invoiceTemplate=String(req.settings.meta_template_invoice||'').trim();
    const invoiceParameters=[sale.customer||'Customer',sale.invoice_no,salon,`Rs ${Number(sale.final_amount).toLocaleString('en-IN')}`,`Rs ${Number(sale.paid_amount).toLocaleString('en-IN')}`,`Rs ${Number(sale.pending_amount).toLocaleString('en-IN')}`,sale.invoice_date];
    let result;try{if(channel==='whatsapp')result=await sendWhatsApp(req.settings,sale.mobile,message,invoiceTemplate||null,invoiceTemplate?invoiceParameters:[]);else if(channel==='email'){const pdf=await generateInvoicePdf(sale,items,req.settings);result=await sendEmail(req.settings,sale.email,`${sale.invoice_no} from ${salon}`,`<p>Hi ${sale.customer||'Customer'},</p><p>Thank you for visiting ${salon}. Your invoice is attached as a PDF.</p><pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${message}</pre>`,[{filename:`${sale.invoice_no}.pdf`,content:pdf,contentType:'application/pdf'}]);}else return res.status(404).send('Not found');}catch(error){result={ok:false,message:error.message};}
    req.flash(result.ok?'success':'error',result.ok?`Invoice sent by ${channel==='whatsapp'?'WhatsApp':'email'}.`:`Could not send by ${channel==='whatsapp'?'WhatsApp':'email'}: ${result.message}`);res.redirect(`/billing/${sid}`);
  }));
  app.get('/api/referral/:cid',auth,asyncRoute(async(req,res)=>{const cid=Number(req.params.cid),salonId=req.user.salon_id,customer=await db.one('SELECT referral_credit,referred_by_id FROM customers WHERE id=:cid AND salon_id=:salonId',{cid,salonId});if(!customer)return res.status(404).json({error:'Customer not found'});const prior=await db.one('SELECT COUNT(*) count FROM sales WHERE salon_id=:salonId AND customer_id=:cid AND cancelled=0',{cid,salonId}),cfg=referralConfig(req.settings);res.json({balance:Number(customer.referral_credit||0),eligible:Number(prior.count)===0,existing_referrer_id:customer.referred_by_id||null,referrer_credit:cfg.referrer_credit,referee_discount:cfg.referee_discount});}));
};
