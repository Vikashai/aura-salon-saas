'use strict';
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const db = require('../db');
const { asyncRoute, isoDate, firstName } = require('../helpers');
const { sendWhatsApp, sendEmail } = require('../notifications');
const { auth, loyaltyConfig, referralConfig, awardPoints, adjustReferralCredit, referralCode } = require('./shared');
const { audit } = require('../access');
const { money, calculateBaseTotals, applyRewards, paymentFromForm } = require('../billing-calculations');

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
  app.get('/login', (req, res) => req.session.user ? res.redirect('/') : res.render('login.html'));
  app.post('/login', loginLimiter, asyncRoute(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const user = await db.one("SELECT * FROM users WHERE username=:username AND status='Active'", { username });
    if (user?.password_hash && await bcrypt.compare(String(req.body.password || ''), user.password_hash)) {
      await new Promise((resolve,reject)=>req.session.regenerate(error=>error?reject(error):resolve()));
      req.session.user = { id: user.id, name: user.name, username: user.username, role: user.role };
      await db.rows('UPDATE users SET last_login=NOW(),last_activity=NOW() WHERE id=:id',{id:user.id});
      await audit(user.id,'auth.login','user',user.id,'Successful login',req);
      const target = req.session.returnTo || '/';
      delete req.session.returnTo;
      return res.redirect(target);
    }
    req.flash('error', 'Incorrect username or password.');
    return res.redirect('/login');
  }));
  app.get('/logout', auth, (req, res) => req.session.destroy(() => res.redirect('/login')));
  app.get('/change-password',auth,(req,res)=>res.render('change_password.html'));
  app.post('/change-password',auth,asyncRoute(async(req,res)=>{const user=await db.one('SELECT * FROM users WHERE id=:id',{id:req.session.user.id}),current=String(req.body.current_password||''),password=String(req.body.new_password||''),confirm=String(req.body.confirm_password||'');if(!user||!await bcrypt.compare(current,user.password_hash)){req.flash('error','Current password is incorrect.');return res.redirect('/change-password');}if(password.length<8||password!==confirm){req.flash('error','New passwords must match and contain at least 8 characters.');return res.redirect('/change-password');}const hash=await bcrypt.hash(password,12);await db.rows('UPDATE users SET password_hash=:hash,force_password_change=0 WHERE id=:id',{hash,id:user.id});await audit(user.id,'auth.password_changed','user',user.id,'Password changed',req);req.flash('success','Password changed successfully.');res.redirect('/');}));

  app.get('/', auth, asyncRoute(async (_req, res) => {
    const today = isoDate();
    const month = today.slice(0, 7);
    const stats = {
      today: (await db.one('SELECT COALESCE(SUM(final_amount),0) value FROM sales WHERE invoice_date=:today AND cancelled=0', { today })).value,
      month: (await db.one("SELECT COALESCE(SUM(final_amount),0) value FROM sales WHERE DATE_FORMAT(invoice_date,'%Y-%m')=:month AND cancelled=0", { month })).value,
      customers: (await db.one('SELECT COUNT(*) value FROM customers WHERE archived=0')).value,
      new: (await db.one("SELECT COUNT(*) value FROM customers WHERE DATE_FORMAT(created_at,'%Y-%m')=:month", { month })).value,
      pending: (await db.one('SELECT COALESCE(SUM(pending_amount),0) value FROM sales WHERE cancelled=0')).value,
      appts_today: (await db.one("SELECT COUNT(*) value FROM appointments WHERE appointment_date=:today AND status NOT IN ('cancelled','no_show')", { today })).value,
    };
    const [recent, customers, low, top_services, upcoming] = await Promise.all([
      db.rows('SELECT s.*,c.name customer FROM sales s LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.id DESC LIMIT 5'),
      db.rows('SELECT * FROM customers WHERE archived=0 ORDER BY id DESC LIMIT 5'),
      db.rows('SELECT * FROM products WHERE archived=0 AND stock<=low_stock ORDER BY stock LIMIT 4'),
      db.rows("SELECT item_name,COUNT(*) qty,SUM(price*quantity-discount) amount FROM sale_items WHERE item_type='Service' GROUP BY item_name ORDER BY amount DESC LIMIT 4"),
      db.rows("SELECT * FROM appointments WHERE appointment_date>=:today AND status IN ('pending','confirmed') ORDER BY appointment_date,appointment_time LIMIT 5", { today }),
    ]);
    res.render('dashboard.html', { stats, recent, customers, low, top_services, upcoming,
      today, today_day: new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date()) });
  }));

  app.get('/customers', auth, asyncRoute(async (req, res) => {
    const q = String(req.query.q || '');
    const like = `%${q}%`;
    const rows = await db.rows(
      `SELECT c.*,COALESCE(SUM(s.final_amount),0) spent,COUNT(s.id) visits,MAX(s.invoice_date) last_visit
       FROM customers c LEFT JOIN sales s ON s.customer_id=c.id AND s.cancelled=0
       WHERE c.archived=0 AND (c.name LIKE :like OR c.mobile LIKE :like OR c.email LIKE :like OR c.customer_id LIKE :like)
       GROUP BY c.id ORDER BY c.id DESC`, { like });
    res.render('customers.html', { rows, q });
  }));

  const customerForm = async (req, res) => {
    const cid = req.params.cid ? Number(req.params.cid) : null;
    if (req.method === 'POST') {
      const values = Object.fromEntries(CUSTOMER_FIELDS.map(field => [field, req.body[field] || null]));
      values.mobile = normalizeIndianMobile(values.mobile);
      values.alt_mobile = normalizeIndianMobile(values.alt_mobile) || null;
      if (!values.mobile || !values.email) {
        req.flash('error', 'WhatsApp mobile number and email are both required.');
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
        await db.rows(`UPDATE customers SET ${assignments},referred_by_id=:referredById WHERE id=:cid`, { ...values, referredById, cid });
      } else {
        const next = await db.one('SELECT COALESCE(MAX(id),0)+1001 next_id FROM customers');
        const code = await referralCode();
        const columns = CUSTOMER_FIELDS.map(field => `\`${field}\``).join(',');
        const params = CUSTOMER_FIELDS.map(field => `:${field}`).join(',');
        await db.rows(`INSERT INTO customers(customer_id,referral_code,referred_by_id,${columns}) VALUES(:customerId,:code,:referredById,${params})`,
          { ...values, customerId: `CUS-${next.next_id}`, code, referredById });
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
    const row = cid ? await db.one('SELECT * FROM customers WHERE id=:cid', { cid }) : null;
    const all_customers = await db.rows('SELECT id,name,mobile FROM customers WHERE archived=0 AND id!=COALESCE(:cid,0) ORDER BY name', { cid });
    return res.render('customer_form.html', { row, all_customers });
  };
  app.get('/customers/new', auth, asyncRoute(customerForm));
  app.post('/customers/new', auth, asyncRoute(customerForm));
  app.get('/customers/:cid/edit', auth, asyncRoute(customerForm));
  app.post('/customers/:cid/edit', auth, asyncRoute(customerForm));

  app.get('/customers/:cid', auth, asyncRoute(async (req, res) => {
    const cid = Number(req.params.cid);
    const [row, bills, appts, loyalty_txns, referral_txns] = await Promise.all([
      db.one('SELECT c.*,r.name referrer_name,COALESCE(c.referred_by,r.name) referred_by FROM customers c LEFT JOIN customers r ON r.id=c.referred_by_id WHERE c.id=:cid', { cid }),
      db.rows('SELECT * FROM sales WHERE customer_id=:cid ORDER BY invoice_date DESC', { cid }),
      db.rows('SELECT * FROM appointments WHERE customer_id=:cid ORDER BY appointment_date DESC LIMIT 10', { cid }),
      db.rows('SELECT * FROM loyalty_transactions WHERE customer_id=:cid ORDER BY id DESC LIMIT 30', { cid }),
      db.rows('SELECT * FROM referral_credit_transactions WHERE customer_id=:cid ORDER BY id DESC LIMIT 30', { cid }),
    ]);
    if (!row) return res.status(404).send('Customer not found');
    const active = bills.filter(bill => !bill.cancelled);
    res.render('customer_profile.html', { row, bills, appts, loyalty_txns, referral_txns,
      spent: active.reduce((sum, bill) => sum + Number(bill.final_amount), 0),
      pending: active.reduce((sum, bill) => sum + Number(bill.pending_amount), 0),
      loyalty_balance: Number(row.loyalty_points || 0), loyalty_cfg: loyaltyConfig(req.settings) });
  }));
  app.post('/customers/:cid/archive', auth, asyncRoute(async (req, res) => {
    await db.rows('UPDATE customers SET archived=1 WHERE id=:cid', { cid: Number(req.params.cid) });
    req.flash('success', 'Customer archived.'); res.redirect('/customers');
  }));

  app.get('/billing', auth, asyncRoute(async (_req, res) => {
    const rows = await db.rows('SELECT s.*,c.name customer FROM sales s LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.invoice_date DESC,s.id DESC');
    const activeRows = rows.filter(row => !row.cancelled);
    const salesTotal = activeRows.reduce((sum, row) => sum + Number(row.final_amount || 0), 0);
    const outstandingTotal = activeRows.reduce((sum, row) => sum + Number(row.pending_amount || 0), 0);
    res.render('billing.html', { rows, salesTotal, outstandingTotal });
  }));
  app.get('/billing/new', auth, asyncRoute(async (req, res) => {
    const [customers, staff, services, products, packages] = await Promise.all([
      db.rows('SELECT * FROM customers WHERE archived=0 ORDER BY name'),
      db.rows("SELECT * FROM staff WHERE archived=0 AND status='Active'"),
      db.rows("SELECT s.id,s.name,s.category,s.price,GROUP_CONCAT(ss.staff_id ORDER BY ss.staff_id) staff_ids FROM services s LEFT JOIN service_staff ss ON ss.service_id=s.id WHERE s.archived=0 AND s.status='Active' GROUP BY s.id ORDER BY s.category,s.name"),
      db.rows("SELECT id,name,category,brand,selling_price price FROM products WHERE archived=0 AND status='Active' ORDER BY category,name"),
      db.rows("SELECT id,name,kind category,price FROM packages WHERE archived=0 AND status='Active' ORDER BY kind,name"),
    ]);
    res.render('bill_form.html', { customers, staff, services, products, packages, loyalty_cfg: loyaltyConfig(req.settings), referral_cfg: referralConfig(req.settings) });
  }));
  app.post('/billing/new', auth, asyncRoute(async (req, res) => {
    const cfg = loyaltyConfig(req.settings);
    const referralCfg = referralConfig(req.settings);
    const customerId = req.body.customer_id ? Number(req.body.customer_id) : null;
    const customerData = customerId ? await db.one('SELECT referral_credit,referred_by_id FROM customers WHERE id=:customerId', { customerId }) : null;
    const priorBillCount = customerId ? Number((await db.one('SELECT COUNT(*) count FROM sales WHERE customer_id=:customerId AND cancelled=0',{customerId})).count) : 0;
    const names = arr(req.body.item_name), types = arr(req.body.item_type), quantities = arr(req.body.quantity), staffNames = arr(req.body.staff_name);
    const catalog = { Service:['services','price'], Product:['products','selling_price'], Package:['packages','price'], Membership:['packages','price'] };
    const normalizedLines = [];
    for (let index = 0; index < names.length; index++) {
      const type = types[index], definition = catalog[type], name = String(names[index] || '').trim();
      if (!definition || !name) continue;
      const item = await db.one(`SELECT name,\`${definition[1]}\` price FROM \`${definition[0]}\` WHERE name=:name AND archived=0 AND status='Active' LIMIT 1`, { name });
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
      const customer = await db.one('SELECT loyalty_points FROM customers WHERE id=:customerId', { customerId });
      pointsUsed = Math.min(pointsUsed, Number(customer?.loyalty_points || 0));
      loyaltyDiscount = Math.min(pointsUsed / cfg.redeem_rate, beforeLoyalty * cfg.max_redeem_pct / 100);
      loyaltyDiscount = Math.round(loyaltyDiscount * 100) / 100;
      pointsUsed = Math.floor(loyaltyDiscount * cfg.redeem_rate);
    } else pointsUsed = 0;
    let referrerId = !priorBillCount ? Number(req.body.referrer_id || customerData?.referred_by_id || 0) : 0;
    if (referrerId === customerId || (referrerId && !await db.one('SELECT id FROM customers WHERE id=:referrerId AND archived=0',{referrerId}))) referrerId = 0;
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
        `INSERT INTO sales(invoice_no,customer_id,invoice_date,subtotal,discount,discount_note,gst_enabled,gst_percent,tax_amount,
         final_amount,paid_amount,pending_amount,payment_mode,payment_status,notes,internal_notes,loyalty_points_used,loyalty_discount,referrer_id,referral_discount,referral_credit_used)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [invoiceNo, customerId, req.body.invoice_date, subtotal, discount, discountNote || null, gst, gstPercent, tax, finalAmount, paid,
          pending, paymentMode, paymentStatus, req.body.notes || null, req.body.internal_notes || null, pointsUsed, loyaltyDiscount,referrerId||null,referralDiscount,referralCreditUsed]);
      for (const line of normalizedLines) {
        await connection.execute('INSERT INTO sale_items(sale_id,item_type,item_name,quantity,price,discount,staff_name) VALUES(?,?,?,?,?,?,?)',
          [sale.insertId, line.type, line.name, line.quantity, line.price, 0, line.staff]);
      }
      if (customerId && cfg.enabled) {
        if (pointsUsed) await awardPoints(connection, customerId, -pointsUsed, 'redeem', `Redeemed on ${invoiceNo} (₹${loyaltyDiscount.toFixed(0)} off)`, 'sale', sale.insertId);
        const eligibleSubtotal=normalizedLines.reduce((sum,line)=>sum+((line.type==='Service'&&cfg.earn_services)||(line.type==='Product'&&cfg.earn_products)?line.quantity*line.price:0),0);
        const earnedBase=subtotal>0?finalAmount*Math.min(eligibleSubtotal/subtotal,1):0;
        const earned = Math.floor(earnedBase * cfg.earn_rate);
        if (earned) {
          await awardPoints(connection, customerId, earned, 'earn', `Earned on ${invoiceNo}`, 'sale', sale.insertId);
          await connection.execute('UPDATE sales SET loyalty_points_earned=? WHERE id=?', [earned, sale.insertId]);
        }
      }
      if (customerId && referralCreditUsed) await adjustReferralCredit(connection,customerId,-referralCreditUsed,'redeem',`Used on ${invoiceNo}`,null,sale.insertId);
      if (customerId && referrerId && !priorBillCount) {
        await connection.execute("UPDATE customers SET referred_by_id=?,source='Referral' WHERE id=?",[referrerId,customerId]);
        if (paid>0 && referralCfg.referrer_credit>0) await adjustReferralCredit(connection,referrerId,referralCfg.referrer_credit,'earn',`Referral reward for ${invoiceNo}`,customerId,sale.insertId);
      }
      return sale.insertId;
    });
    req.flash('success', `${invoiceNo} created successfully.`);
    res.redirect(`/billing/${result}`);
  }));
  app.get('/billing/:sid', auth, asyncRoute(async (req, res) => {
    const sid = Number(req.params.sid);
    const [sale, items] = await Promise.all([
      db.one('SELECT s.*,c.name customer,c.mobile,c.email,c.address,c.city,c.state FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=:sid', { sid }),
      db.rows('SELECT * FROM sale_items WHERE sale_id=:sid', { sid }),
    ]);
    if (!sale) return res.status(404).send('Invoice not found');
    res.render('invoice.html', { sale, items, settings: req.settings });
  }));
  app.get('/billing/:sid/edit', auth, asyncRoute(async(req,res)=>{
    const sid=Number(req.params.sid),sale=await db.one('SELECT s.*,c.name customer FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=:sid',{sid});
    if(!sale)return res.status(404).send('Invoice not found');
    res.render('invoice_edit.html',{sale});
  }));
  app.post('/billing/:sid/edit', auth, asyncRoute(async(req,res)=>{
    const sid=Number(req.params.sid),sale=await db.one('SELECT * FROM sales WHERE id=:sid',{sid});if(!sale)return res.status(404).send('Invoice not found');
    const requestedDiscount=Math.max(Number(req.body.discount||0),0),discountNote=String(req.body.discount_note||'').trim();
    if(requestedDiscount>0&&!discountNote){req.flash('error','Enter a reason for the discount.');return res.redirect(`/billing/${sid}/edit`);}
    const gst=req.body.gst_enabled?1:0,base=calculateBaseTotals({subtotal:sale.subtotal,discount:requestedDiscount,gstEnabled:Boolean(gst),gstPercent:req.body.gst_percent}),rewards=applyRewards(base.beforeRewards,sale.loyalty_discount,sale.referral_discount,sale.referral_credit_used),{discount,gstPercent,tax}=base,{finalAmount}=rewards;
    const payment=paymentFromForm({paid_amount:req.body.paid_amount,payment_mode:req.body.payment_mode},finalAmount);if(payment.error){req.flash('error',payment.error);return res.redirect(`/billing/${sid}/edit`);}const {paid}=payment,pending=money(finalAmount-paid),status=pending===0?'Paid':paid>0?'Partially Paid':'Pending';
    await db.rows('UPDATE sales SET invoice_date=:invoiceDate,discount=:discount,discount_note=:discountNote,gst_enabled=:gst,gst_percent=:gstPercent,tax_amount=:tax,final_amount=:finalAmount,paid_amount=:paid,pending_amount=:pending,payment_mode=:paymentMode,payment_status=:status,notes=:notes,internal_notes=:internalNotes WHERE id=:sid',{invoiceDate:req.body.invoice_date,discount,discountNote:discountNote||null,gst,gstPercent,tax,finalAmount,paid,pending,paymentMode:req.body.payment_mode,status,notes:req.body.notes||null,internalNotes:req.body.internal_notes||null,sid});
    if(Number(sale.paid_amount||0)<=0&&paid>0&&sale.referrer_id){const existing=await db.one("SELECT id FROM referral_credit_transactions WHERE sale_id=:sid AND type='earn'",{sid});const reward=referralConfig(req.settings).referrer_credit;if(!existing&&reward>0)await db.transaction(connection=>adjustReferralCredit(connection,sale.referrer_id,reward,'earn',`Referral reward for ${sale.invoice_no}`,sale.customer_id,sid));}
    req.flash('success',`${sale.invoice_no} updated.`);res.redirect(`/billing/${sid}`);
  }));
  app.post('/billing/:sid/send/:channel', auth, asyncRoute(async(req,res)=>{
    const sid=Number(req.params.sid),channel=req.params.channel,[sale,items]=await Promise.all([db.one('SELECT s.*,c.name customer,c.mobile,c.email FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=:sid',{sid}),db.rows('SELECT * FROM sale_items WHERE sale_id=:sid',{sid})]);
    if(!sale)return res.status(404).send('Invoice not found');
    const salon=req.settings.salon_name||'Aura Salon',itemText=items.map(item=>`${item.item_name} x ${Number(item.quantity)} - ₹${(Number(item.quantity)*Number(item.price)).toLocaleString('en-IN')}`).join('\n');
    const message=`Hi ${sale.customer||'Customer'},\n\nInvoice ${sale.invoice_no} from ${salon}\n${itemText}\n\nTotal: ₹${Number(sale.final_amount).toLocaleString('en-IN')}\nPaid: ₹${Number(sale.paid_amount).toLocaleString('en-IN')}\nBalance: ₹${Number(sale.pending_amount).toLocaleString('en-IN')}\nDate: ${sale.invoice_date}\n\nThank you for visiting ${salon}.`;
    let result;try{if(channel==='whatsapp')result=await sendWhatsApp(req.settings,sale.mobile,message,null,[]);else if(channel==='email')result=await sendEmail(req.settings,sale.email,`${sale.invoice_no} from ${salon}`,`<p>Hi ${sale.customer||'Customer'},</p><p>Thank you for visiting ${salon}.</p><pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${message}</pre>`);else return res.status(404).send('Not found');}catch(error){result={ok:false,message:error.message};}
    req.flash(result.ok?'success':'error',result.ok?`Invoice sent by ${channel==='whatsapp'?'WhatsApp':'email'}.`:`Could not send by ${channel==='whatsapp'?'WhatsApp':'email'}: ${result.message}`);res.redirect(`/billing/${sid}`);
  }));
  app.get('/api/referral/:cid',auth,asyncRoute(async(req,res)=>{const cid=Number(req.params.cid),customer=await db.one('SELECT referral_credit,referred_by_id FROM customers WHERE id=:cid',{cid});if(!customer)return res.status(404).json({error:'Customer not found'});const prior=await db.one('SELECT COUNT(*) count FROM sales WHERE customer_id=:cid AND cancelled=0',{cid}),cfg=referralConfig(req.settings);res.json({balance:Number(customer.referral_credit||0),eligible:Number(prior.count)===0,existing_referrer_id:customer.referred_by_id||null,referrer_credit:cfg.referrer_credit,referee_discount:cfg.referee_discount});}));
};
