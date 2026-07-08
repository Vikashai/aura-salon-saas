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

function normalizeIndianMobile(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  return digits;
}

module.exports = app => {
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
    message: 'Too many login attempts. Please try again in 15 minutes.' });
  app.get('/login', (req, res) => req.session.user ? res.redirect('/dashboard') : res.render('login.html'));
  app.post('/login', loginLimiter, asyncRoute(async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const candidates = await db.platformRows(
      `SELECT u.*,s.slug salon_slug,s.status salon_status
       FROM users u JOIN salons s ON s.id=u.salon_id
       WHERE (LOWER(u.username)=:username OR LOWER(u.email)=:username) AND u.status='Active' AND s.status='Active'
         AND (s.access_starts_at IS NULL OR s.access_starts_at<=NOW())
         AND (s.access_ends_at IS NULL OR s.access_ends_at>=NOW())`,
      { username },
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
    req.flash('error', 'Incorrect username or password.');
    return res.redirect('/login');
  }));
  const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false,
    message: 'Too many password reset attempts. Please try again in 15 minutes.' });
  app.get('/forgot-password',(req,res)=>res.render('forgot_password.html'));
  app.post('/forgot-password',resetLimiter,asyncRoute(async(req,res)=>{
    const email=String(req.body.email||'').trim().toLowerCase();
    const users=await db.platformRows(`SELECT u.id,u.salon_id,u.name,u.email,s.name salon_name
      FROM users u JOIN salons s ON s.id=u.salon_id
      WHERE LOWER(u.email)=? AND u.status='Active' AND s.status='Active'
        AND (s.access_starts_at IS NULL OR s.access_starts_at<=NOW())
        AND (s.access_ends_at IS NULL OR s.access_ends_at>=NOW())`,[email]);
    if(users.length===1&&/^\S+@\S+\.\S+$/.test(email)){
      const user=users[0],otp=crypto.randomInt(0,1000000).toString().padStart(6,'0'),otpHash=crypto.createHash('sha256').update(otp).digest('hex');
      await db.rows('UPDATE password_reset_tokens SET used_at=NOW() WHERE salon_id=:salonId AND user_id=:userId AND used_at IS NULL',{salonId:user.salon_id,userId:user.id});
      await db.rows('INSERT INTO password_reset_tokens(salon_id,user_id,token_hash,expires_at) VALUES(:salonId,:userId,:otpHash,DATE_ADD(NOW(),INTERVAL 10 MINUTE))',{salonId:user.salon_id,userId:user.id,otpHash});
      try{await sendPlatformEmail(email,'Your Aura password reset code',`<p>Hello ${String(user.name||'').replace(/[<>&"']/g,'')},</p><p>Your Aura password reset code is:</p><p style="font-size:28px;font-weight:800;letter-spacing:6px">${otp}</p><p>This code expires in 10 minutes and works once. If you did not request it, ignore this email.</p>`);}catch(error){console.error('Password reset email failed:',error.message);}
    }
    req.session.passwordResetEmail=email;
    req.flash('info','If an active Aura account uses that email, a six-digit code has been sent.');
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
    const [recent, customers, low, top_services, upcoming] = await Promise.all([
      db.rows('SELECT s.*,c.name customer FROM sales s LEFT JOIN customers c ON c.id=s.customer_id AND c.salon_id=s.salon_id WHERE s.salon_id=:salonId ORDER BY s.id DESC LIMIT 5',{salonId}),
      db.rows('SELECT * FROM customers WHERE salon_id=:salonId AND archived=0 ORDER BY id DESC LIMIT 5',{salonId}),
      db.rows('SELECT * FROM products WHERE salon_id=:salonId AND archived=0 AND stock<=low_stock ORDER BY stock LIMIT 4',{salonId}),
      db.rows("SELECT item_name,COUNT(*) qty,SUM(price*quantity-discount) amount FROM sale_items WHERE salon_id=:salonId AND item_type='Service' GROUP BY item_name ORDER BY amount DESC LIMIT 4",{salonId}),
      db.rows("SELECT * FROM appointments WHERE salon_id=:salonId AND appointment_date>=:today AND status IN ('pending','confirmed') ORDER BY appointment_date,appointment_time LIMIT 5", {salonId,today}),
    ]);
    res.render('dashboard.html', { stats, recent, customers, low, top_services, upcoming,
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

  const customerForm = async (req, res) => {
    const cid = req.params.cid ? Number(req.params.cid) : null;
    const salonId=req.user.salon_id;
    if (req.method === 'POST') {
      const values = Object.fromEntries(CUSTOMER_FIELDS.map(field => [field, req.body[field] || null]));
      values.mobile = normalizeIndianMobile(values.mobile);
      values.alt_mobile = normalizeIndianMobile(values.alt_mobile) || null;
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
    const names = arr(req.body.item_name), types = arr(req.body.item_type), quantities = arr(req.body.quantity), staffNames = arr(req.body.staff_name);
    const catalog = { Service:['services','price'], Product:['products','selling_price'], Package:['packages','price'], Membership:['packages','price'] };
    const normalizedLines = [];
    for (let index = 0; index < names.length; index++) {
      const type = types[index], definition = catalog[type], name = String(names[index] || '').trim();
      if (!definition || !name) continue;
      const item=await db.one(`SELECT name,\`${definition[1]}\` price FROM \`${definition[0]}\` WHERE salon_id=:salonId AND name=:name AND archived=0 AND status='Active' LIMIT 1`,{name,salonId});
      if (!item) continue;
      const quantity=Number(quantities[index] ?? 1),price=Number(item.price||0);
      if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(price)||price<0)continue;
      normalizedLines.push({ type, name:item.name, quantity, price, staff:staffNames[index] || null });
    }
    if (!normalizedLines.length) { req.flash('error', 'Select at least one valid service, product or package.'); return res.redirect('/billing/new'); }
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
        await connection.execute('INSERT INTO sale_items(salon_id,sale_id,item_type,item_name,quantity,price,discount,staff_name) VALUES(?,?,?,?,?,?,?,?)',
          [salonId,sale.insertId,line.type,line.name,line.quantity,line.price,0,line.staff]);
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
    if(String(req.settings.billing_auto_whatsapp||'0')==='1'&&customerId){
      const customer=await db.one('SELECT name,mobile FROM customers WHERE id=:customerId AND salon_id=:salonId',{customerId,salonId});
      const template=String(req.settings.meta_template_invoice||'').trim();
      if(!template)req.flash('error','Invoice WhatsApp was not sent: configure an approved invoice template in Settings.');
      else if(customer?.mobile){
        const salon=req.settings.salon_name||'Aura Salon';
        const parameters=[customer.name||'Customer',invoiceNo,salon,`Rs ${Number(finalAmount).toLocaleString('en-IN')}`,`Rs ${Number(paid).toLocaleString('en-IN')}`,`Rs ${Number(pending).toLocaleString('en-IN')}`,req.body.invoice_date];
        const message=`Invoice ${invoiceNo} from ${salon}. Total: ${parameters[3]}; Paid: ${parameters[4]}; Balance: ${parameters[5]}.`;
        const sent=await sendWhatsApp(req.settings,customer.mobile,message,template,parameters);
        if(!sent.ok)req.flash('error',`Invoice WhatsApp failed: ${sent.message}`);
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
    res.render('invoice.html', { sale, items, settings: req.settings });
  }));
  app.get('/billing/:sid/pdf',auth,asyncRoute(async(req,res)=>{
    const sid=Number(req.params.sid),salonId=req.user.salon_id,[sale,items]=await Promise.all([db.one('SELECT s.*,c.name customer,c.mobile,c.email,c.address,c.city,c.state FROM sales s LEFT JOIN customers c ON c.id=s.customer_id AND c.salon_id=s.salon_id WHERE s.id=:sid AND s.salon_id=:salonId',{sid,salonId}),db.rows('SELECT * FROM sale_items WHERE sale_id=:sid AND salon_id=:salonId',{sid,salonId})]);
    if(!sale)return res.status(404).send('Invoice not found');
    const pdf=await generateInvoicePdf(sale,items,req.settings);res.type('application/pdf').attachment(`${sale.invoice_no}.pdf`).send(pdf);
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
