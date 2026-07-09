'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { rateLimit } = require('express-rate-limit');
const db = require('../db');
const { asyncRoute } = require('../helpers');
const { sendPlatformEmail } = require('../notifications');

const platformAuth = (req,res,next) => req.session.platformAdmin ? next() : res.redirect('/platform/login');
const slugify = value => String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70) || 'salon';
const validEmail = value => /^\S+@\S+\.\S+$/.test(String(value||''));
const validUsername = value => /^[a-z0-9._-]{3,40}$/.test(String(value||''));
const tokenHash = token => crypto.createHash('sha256').update(String(token||'')).digest('hex');
async function uniqueSlug(name) {
  const base=slugify(name); let slug=base; let suffix=1;
  while(await db.one('SELECT id FROM salons WHERE slug=:slug',{slug})) slug=`${base}-${++suffix}`;
  return slug;
}

module.exports = app => {
  const limiter=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false});
  async function recoveryContext(req) {
    const [salons,users]=await Promise.all([
      db.platformRows('SELECT id,name,slug,status FROM salons ORDER BY name, id'),
      db.platformRows(`SELECT u.id,u.salon_id,u.name,u.username,u.email,u.role,u.status
        FROM users u JOIN salons s ON s.id=u.salon_id
        ORDER BY s.name,u.name,u.username,u.id`)
    ]);
    return {platform_admin:req.session.platformAdmin,salons,users};
  }
  async function sendAdminLink(admin,purpose) {
    const token=crypto.randomBytes(32).toString('hex'),hash=tokenHash(token);
    await db.platformRows('UPDATE platform_admin_tokens SET used_at=NOW() WHERE admin_id=? AND used_at IS NULL',[admin.id]);
    await db.platformRows('INSERT INTO platform_admin_tokens(admin_id,token_hash,purpose,expires_at) VALUES(?,?,?,DATE_ADD(NOW(),INTERVAL 30 MINUTE))',[admin.id,hash,purpose]);
    const base=String(process.env.APP_BASE_URL||'').replace(/\/$/,'');
    const action=purpose==='invite'?'Set up your Company Admin account':'Reset your Company Admin password';
    return sendPlatformEmail(admin.email,action,`<p>Hello ${String(admin.name||'').replace(/[<>&"']/g,'')},</p><p>${action}. This secure link expires in 30 minutes and works once.</p><p><a href="${base}/platform/account-password?token=${token}">${action}</a></p><p>If you did not expect this, ignore this email.</p>`);
  }
  app.get('/start-free',(req,res)=>res.render('start_free.html'));
  app.post('/start-free',asyncRoute(async(req,res)=>{
    const salonName=String(req.body.salon_name||'').trim(),ownerName=String(req.body.owner_name||'').trim();
    const email=String(req.body.email||'').trim().toLowerCase(),mobile=String(req.body.mobile||'').replace(/\D/g,'');
    if(!salonName||!ownerName||!/^\S+@\S+\.\S+$/.test(email)||mobile.length<10){req.flash('error','Enter the salon, owner, email and a valid mobile number.');return res.redirect('/start-free');}
    await db.rows('INSERT INTO salon_applications(salon_name,owner_name,email,mobile,city,message) VALUES(:salonName,:ownerName,:email,:mobile,:city,:message)',{salonName,ownerName,email,mobile,city:String(req.body.city||'').trim()||null,message:String(req.body.message||'').trim()||null});
    req.flash('success','Application received. We will contact you after review.');res.redirect('/start-free');
  }));
  app.get('/platform/login',(req,res)=>req.session.platformAdmin?res.redirect('/platform'):res.render('platform_login.html'));
  app.post('/platform/login',limiter,asyncRoute(async(req,res)=>{
    const username=String(req.body.username||'').trim().toLowerCase();
    const admin=await db.platformOne("SELECT * FROM platform_admins WHERE (LOWER(username)=? OR LOWER(email)=?) AND status='Active'",[username,username]);
    if(admin&&await bcrypt.compare(String(req.body.password||''),admin.password_hash)){
      await new Promise((resolve,reject)=>req.session.regenerate(error=>error?reject(error):resolve()));
      req.session.platformAdmin={id:admin.id,name:admin.name,username:admin.username};
      await db.rows('UPDATE platform_admins SET last_login=NOW() WHERE id=:id',{id:admin.id});return res.redirect('/platform');
    }
    req.flash('error','Incorrect platform administrator credentials.');res.redirect('/platform/login');
  }));
  app.get('/platform/forgot-password',(req,res)=>res.render('platform_forgot_password.html'));
  app.post('/platform/forgot-password',limiter,asyncRoute(async(req,res)=>{
    const email=String(req.body.email||'').trim().toLowerCase();
    const admin=validEmail(email)?await db.platformOne("SELECT id,name,email FROM platform_admins WHERE LOWER(email)=? AND status='Active'",[email]):null;
    if(admin){
      const otp=crypto.randomInt(0,1000000).toString().padStart(6,'0'),hash=tokenHash(otp);
      await db.platformRows('UPDATE platform_admin_tokens SET used_at=NOW() WHERE admin_id=? AND used_at IS NULL',[admin.id]);
      await db.platformRows("INSERT INTO platform_admin_tokens(admin_id,token_hash,purpose,expires_at) VALUES(?,?, 'reset',DATE_ADD(NOW(),INTERVAL 10 MINUTE))",[admin.id,hash]);
      try{await sendPlatformEmail(admin.email,'Your Aura Company Admin reset code',`<p>Hello ${String(admin.name||'').replace(/[<>&"']/g,'')},</p><p>Your Company Admin password reset code is:</p><p style="font-size:28px;font-weight:800;letter-spacing:6px">${otp}</p><p>This code expires in 10 minutes and works once.</p>`);}catch(error){console.error('Company admin reset email failed:',error.message);}
    }
    req.session.platformResetEmail=email;req.flash('info','If an active Company Admin uses that email, a six-digit code has been sent.');res.redirect('/platform/reset-password');
  }));
  app.get('/platform/reset-password',(req,res)=>res.render('platform_reset_password.html',{email:req.session.platformResetEmail||''}));
  app.post('/platform/reset-password',limiter,asyncRoute(async(req,res)=>{
    const email=String(req.body.email||req.session.platformResetEmail||'').trim().toLowerCase(),otp=String(req.body.otp||'').replace(/\D/g,''),password=String(req.body.password||''),confirm=String(req.body.confirm_password||'');
    const record=otp.length===6?await db.platformOne(`SELECT t.id,t.admin_id FROM platform_admin_tokens t JOIN platform_admins a ON a.id=t.admin_id WHERE LOWER(a.email)=? AND t.token_hash=? AND t.purpose='reset' AND t.used_at IS NULL AND t.expires_at>NOW() AND a.status='Active'`,[email,tokenHash(otp)]):null;
    if(!record||password.length<8||password!==confirm){req.flash('error','The code is invalid or expired, or the passwords do not match.');return res.redirect('/platform/reset-password');}
    const hash=await bcrypt.hash(password,12);
    await db.transaction(async connection=>{await connection.execute('UPDATE platform_admins SET password_hash=? WHERE id=?',[hash,record.admin_id]);await connection.execute('UPDATE platform_admin_tokens SET used_at=NOW() WHERE id=?',[record.id]);});
    delete req.session.platformResetEmail;req.flash('success','Company Admin password reset. You can sign in now.');res.redirect('/platform/login');
  }));
  app.get('/platform/account-password',asyncRoute(async(req,res)=>{
    const token=String(req.query.token||''),record=token?await db.platformOne('SELECT id,purpose FROM platform_admin_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>NOW()',[tokenHash(token)]):null;
    res.render('platform_account_password.html',{token:record?token:'',invalid:!record,purpose:record?.purpose||'reset'});
  }));
  app.post('/platform/account-password',limiter,asyncRoute(async(req,res)=>{
    const token=String(req.body.token||''),password=String(req.body.password||''),confirm=String(req.body.confirm_password||'');
    const record=token?await db.platformOne('SELECT id,admin_id FROM platform_admin_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>NOW()',[tokenHash(token)]):null;
    if(!record||password.length<8||password!==confirm){req.flash('error','The link is invalid or expired, or the passwords do not match.');return res.redirect(`/platform/account-password?token=${encodeURIComponent(token)}`);}
    const hash=await bcrypt.hash(password,12);
    await db.transaction(async connection=>{await connection.execute("UPDATE platform_admins SET password_hash=?,status='Active' WHERE id=?",[hash,record.admin_id]);await connection.execute('UPDATE platform_admin_tokens SET used_at=NOW() WHERE id=?',[record.id]);});
    req.flash('success','Company Admin password saved. You can sign in now.');res.redirect('/platform/login');
  }));
  app.post('/platform/logout',platformAuth,(req,res)=>req.session.destroy(()=>res.redirect('/platform/login')));
  app.get('/platform',platformAuth,asyncRoute(async(req,res)=>{
    const [applications,salons]=await Promise.all([
      db.rows('SELECT * FROM salon_applications ORDER BY id DESC LIMIT 50'),
      db.platformRows(`SELECT s.*,
        (SELECT COUNT(*) FROM users u WHERE u.salon_id=s.id AND u.status='Active') user_count,
        (SELECT COUNT(*) FROM customers c WHERE c.salon_id=s.id AND c.archived=0) customer_count,
        (SELECT COUNT(*) FROM appointments a WHERE a.salon_id=s.id AND a.appointment_date>=CURDATE()) upcoming_count,
        (SELECT COALESCE(SUM(x.final_amount),0) FROM sales x WHERE x.salon_id=s.id AND x.cancelled=0 AND x.invoice_date>=DATE_FORMAT(CURDATE(),'%Y-%m-01')) month_sales
        FROM salons s ORDER BY s.id DESC`),
    ]);
    const today=Date.now(),week=7*86400000;
    const stats={total:salons.length,active:salons.filter(s=>s.status==='Active'&&(!s.access_ends_at||new Date(s.access_ends_at).getTime()>=today)).length,pending:applications.filter(a=>a.status==='New').length,overdue:salons.filter(s=>s.payment_status==='Overdue').length,customers:salons.reduce((sum,s)=>sum+Number(s.customer_count||0),0),users:salons.reduce((sum,s)=>sum+Number(s.user_count||0),0),month_sales:salons.reduce((sum,s)=>sum+Number(s.month_sales||0),0),expiring:salons.filter(s=>s.access_ends_at&&new Date(s.access_ends_at).getTime()>=today&&new Date(s.access_ends_at).getTime()<=today+week).length};
    res.render('platform_dashboard.html',{applications,salons,stats,platform_admin:req.session.platformAdmin});
  }));
  app.get('/platform/email',platformAuth,(req,res)=>res.render('platform_email.html',{
    platform_admin:req.session.platformAdmin,
    configured:Boolean(process.env.SMTP_USER&&process.env.SMTP_PASSWORD),
    sender:process.env.SMTP_FROM||process.env.SMTP_USER||'',
    senderName:process.env.SMTP_FROM_NAME||'Aura Salon OS',
  }));
  app.get('/platform/admins',platformAuth,asyncRoute(async(req,res)=>{
    const admins=await db.platformRows('SELECT id,name,username,email,status,last_login,created_at FROM platform_admins ORDER BY id');
    res.render('platform_admins.html',{admins,platform_admin:req.session.platformAdmin});
  }));
  app.post('/platform/admins/invite',platformAuth,asyncRoute(async(req,res)=>{
    const name=String(req.body.name||'').trim(),username=String(req.body.username||'').trim().toLowerCase(),email=String(req.body.email||'').trim().toLowerCase();
    if(!name||!validUsername(username)||!validEmail(email)){req.flash('error','Enter a name, valid username and real email address.');return res.redirect('/platform/admins');}
    if(await db.platformOne('SELECT id FROM platform_admins WHERE LOWER(username)=? OR LOWER(email)=?',[username,email])){req.flash('error','That username or email is already used.');return res.redirect('/platform/admins');}
    const placeholder=await bcrypt.hash(crypto.randomBytes(32).toString('hex'),12);
    const result=await db.platformRows("INSERT INTO platform_admins(name,username,email,password_hash,status) VALUES(?,?,?,?,'Invited')",[name,username,email,placeholder]);
    const admin={id:result.insertId,name,email};
    try{await sendAdminLink(admin,'invite');req.flash('success',`Invitation sent to ${email}.`);}catch(error){req.flash('error',`Admin created, but invitation failed: ${error.message}`);}
    res.redirect('/platform/admins');
  }));
  app.post('/platform/admins/:id/resend',platformAuth,asyncRoute(async(req,res)=>{
    const admin=await db.platformOne("SELECT id,name,email FROM platform_admins WHERE id=? AND status='Invited'",[Number(req.params.id)]);
    if(!admin||!admin.email){req.flash('error','Invited administrator not found.');return res.redirect('/platform/admins');}
    try{await sendAdminLink(admin,'invite');req.flash('success',`Invitation resent to ${admin.email}.`);}catch(error){req.flash('error',`Invitation failed: ${error.message}`);}res.redirect('/platform/admins');
  }));
  app.post('/platform/admins/:id/deactivate',platformAuth,asyncRoute(async(req,res)=>{
    const id=Number(req.params.id);
    if(id===Number(req.session.platformAdmin.id)){req.flash('error','You cannot deactivate your current session.');return res.redirect('/platform/admins');}
    const count=await db.platformOne("SELECT COUNT(*) count FROM platform_admins WHERE status='Active'");
    if(Number(count.count)<=1){req.flash('error','Aura must always have at least one active Company Admin.');return res.redirect('/platform/admins');}
    await db.platformRows("UPDATE platform_admins SET status='Inactive' WHERE id=?",[id]);req.flash('success','Company Admin deactivated.');res.redirect('/platform/admins');
  }));
  app.post('/platform/email/test',platformAuth,asyncRoute(async(req,res)=>{
    const recipient=String(req.body.recipient||'').trim().toLowerCase();
    if(!/^\S+@\S+\.\S+$/.test(recipient)){req.flash('error','Enter a valid recipient email.');return res.redirect('/platform/email');}
    try{
      const result=await sendPlatformEmail(recipient,'Aura Salon OS email test','<h2>Aura Salon OS</h2><p>Your company email connection is working correctly.</p><p>Password resets and platform notifications can now be delivered through this sender.</p>');
      req.flash(result.ok?'success':'error',result.ok?`Test email sent to ${recipient}.`:`Email test failed: ${result.message}`);
    }catch(error){req.flash('error',`Email test failed: ${error.message}`);}
    res.redirect('/platform/email');
  }));
  app.get('/platform/salons/:id',platformAuth,asyncRoute(async(req,res)=>{
    const id=Number(req.params.id),salon=await db.one('SELECT * FROM salons WHERE id=:id',{id});if(!salon)return res.status(404).send('Salon not found');
    const [users,activity,recentSales,recentAppointments,application]=await Promise.all([
      db.platformRows('SELECT id,name,username,role,status,last_login,last_activity FROM users WHERE salon_id=? ORDER BY id',[id]),
      db.platformOne(`SELECT
        (SELECT COUNT(*) FROM customers WHERE salon_id=?) customers,
        (SELECT COUNT(*) FROM staff WHERE salon_id=? AND archived=0) staff,
        (SELECT COUNT(*) FROM services WHERE salon_id=? AND archived=0) services,
        (SELECT COUNT(*) FROM appointments WHERE salon_id=?) appointments,
        (SELECT COUNT(*) FROM sales WHERE salon_id=? AND cancelled=0) invoices,
        (SELECT COALESCE(SUM(final_amount),0) FROM sales WHERE salon_id=? AND cancelled=0) lifetime_sales`,[id,id,id,id,id,id]),
      db.platformRows('SELECT invoice_no,invoice_date,final_amount,payment_status FROM sales WHERE salon_id=? ORDER BY id DESC LIMIT 8',[id]),
      db.platformRows('SELECT appointment_id,customer_name,service_name,appointment_date,status FROM appointments WHERE salon_id=? ORDER BY id DESC LIMIT 8',[id]),
      db.one('SELECT * FROM salon_applications WHERE salon_id=:id ORDER BY id DESC LIMIT 1',{id}),
    ]);
    res.render('platform_salon.html',{salon,users,activity,recentSales,recentAppointments,application,platform_admin:req.session.platformAdmin});
  }));
  app.post('/platform/applications/:id/approve',platformAuth,asyncRoute(async(req,res)=>{
    const id=Number(req.params.id),application=await db.one("SELECT * FROM salon_applications WHERE id=:id AND status='New'",{id});
    if(!application){req.flash('error','This application is no longer awaiting review.');return res.redirect('/platform');}
    if(await db.platformOne('SELECT id FROM users WHERE LOWER(email)=?',[String(application.email||'').trim().toLowerCase()])){req.flash('error','That owner email is already connected to another Aura account. Use a different email before approving.');return res.redirect('/platform');}
    const slug=await uniqueSlug(application.salon_name);
    const temporaryPassword=crypto.randomBytes(9).toString('base64url');
    const passwordHash=await bcrypt.hash(temporaryPassword,12),ownerUsername=`${slug}-owner`.slice(0,100);
    const result=await db.transaction(async connection=>{
      const [salon]=await connection.execute("INSERT INTO salons(name,slug,status,owner_name,owner_email,owner_mobile,payment_status,access_starts_at,access_ends_at,approved_at) VALUES(?,?,'Active',?,?,?,'Pending',NOW(),DATE_ADD(NOW(),INTERVAL 30 DAY),NOW())",[application.salon_name,slug,application.owner_name,application.email,application.mobile]);
      await connection.execute("UPDATE salon_applications SET status='Approved',salon_id=?,reviewed_at=NOW() WHERE id=?",[salon.insertId,id]);return salon;
    });
    await db.transaction(async connection=>{
      await connection.execute("INSERT INTO capacity_pools(salon_id,name,seats,is_default) VALUES(?,'General',1,1)",[result.insertId]);
      await connection.execute("INSERT INTO settings(salon_id,`key`,`value`) SELECT ?,`key`,`value` FROM settings WHERE salon_id=(SELECT MIN(id) FROM salons WHERE status='Active') ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)",[result.insertId]);
      await connection.execute("INSERT INTO users(salon_id,name,username,email,password_hash,role,status,force_password_change) VALUES(?,?,?,?,?, 'owner','Active',1)",[result.insertId,application.owner_name,ownerUsername,application.email,passwordHash]);
    });
    req.flash('success',`${application.salon_name} approved. Workspace: ${slug}; owner email: ${application.email}; temporary password: ${temporaryPassword}`);res.redirect('/platform');
  }));
  app.post('/platform/applications/:id/reject',platformAuth,asyncRoute(async(req,res)=>{
    await db.rows("UPDATE salon_applications SET status='Rejected',reviewed_at=NOW() WHERE id=:id AND status='New'",{id:Number(req.params.id)});req.flash('success','Application rejected.');res.redirect('/platform');
  }));
  app.get('/platform/recovery',platformAuth,asyncRoute(async(req,res)=>res.render('platform_recovery.html',await recoveryContext(req))));
  app.post('/platform/recovery',platformAuth,asyncRoute(async(req,res)=>{
    const salonId=Number(req.body.salon_id||0),userId=Number(req.body.user_id||0);
    const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');
    const user=await db.platformOne(`SELECT u.id,u.salon_id,u.username,u.name,s.name salon_name
      FROM users u JOIN salons s ON s.id=u.salon_id
      WHERE u.id=? AND u.salon_id=?`,[userId,salonId]);
    if(!user||!/^\S+@\S+\.\S+$/.test(email)||password.length<8){req.flash('error','Select a salon, user account, valid email and temporary password of at least 8 characters.');return res.redirect('/platform/recovery');}
    const duplicate=await db.platformOne('SELECT id FROM users WHERE LOWER(email)=? AND id<>?',[email,user.id]);
    if(duplicate){req.flash('error','That email is already connected to another Aura user.');return res.redirect('/platform/recovery');}
    const passwordHash=await bcrypt.hash(password,12);
    await db.rows('UPDATE users SET email=:email,password_hash=:passwordHash,password_changed_at=NOW(),force_password_change=1 WHERE id=:id AND salon_id=:salonId',{email,passwordHash,id:user.id,salonId:user.salon_id});
    await db.rows('INSERT INTO audit_logs(salon_id,user_id,action,target_type,target_id,details,ip_address) VALUES(:salonId,NULL,:action,:targetType,:targetId,:details,:ip)',{salonId:user.salon_id,action:'platform.account_recovery',targetType:'user',targetId:user.id,details:`Company admin recovered ${user.username}`,ip:req.ip||null});
    req.flash('success',`Recovery details saved for ${user.username} at ${user.salon_name}.`);res.redirect('/platform/recovery');
  }));
  async function deliveryResetContext(id) {
    const salon=await db.platformOne('SELECT id,name,slug,status FROM salons WHERE id=?',[id]);
    if(!salon)return null;
    const counts={};
    for(const [key,sql] of Object.entries({
      customers:'SELECT COUNT(*) value FROM customers WHERE salon_id=?',
      appointments:'SELECT COUNT(*) value FROM appointments WHERE salon_id=?',
      invoices:'SELECT COUNT(*) value FROM sales WHERE salon_id=?',
      invoice_items:'SELECT COUNT(*) value FROM sale_items WHERE salon_id=?',
      expenses:'SELECT COUNT(*) value FROM expenses WHERE salon_id=?',
      loyalty:'SELECT COUNT(*) value FROM loyalty_transactions WHERE salon_id=?',
      referral:'SELECT COUNT(*) value FROM referral_credit_transactions WHERE salon_id=?',
      whatsapp_events:'SELECT COUNT(*) value FROM whatsapp_webhook_events WHERE salon_id=?',
      audit_logs:'SELECT COUNT(*) value FROM audit_logs WHERE salon_id=?',
      password_resets:'SELECT COUNT(*) value FROM password_reset_tokens WHERE salon_id=?',
      services_kept:'SELECT COUNT(*) value FROM services WHERE salon_id=? AND archived=0',
      staff_kept:'SELECT COUNT(*) value FROM staff WHERE salon_id=? AND archived=0',
      products_kept:'SELECT COUNT(*) value FROM products WHERE salon_id=? AND archived=0',
      packages_kept:'SELECT COUNT(*) value FROM packages WHERE salon_id=? AND archived=0',
    })){
      counts[key]=Number((await db.platformOne(sql,[id]))?.value||0);
    }
    return {salon,counts};
  }
  app.get('/platform/salons/:id/delivery-reset',platformAuth,asyncRoute(async(req,res)=>{
    const context=await deliveryResetContext(Number(req.params.id));if(!context)return res.status(404).send('Salon not found');
    const {salon,counts}=context,removable=['customers','appointments','invoices','invoice_items','expenses','loyalty','referral','whatsapp_events','audit_logs','password_resets'],kept=['services_kept','staff_kept','products_kept','packages_kept'];
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Delivery reset · ${salon.name}</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f6f1;color:#20211f;font:14px Arial,sans-serif}.wrap{width:min(900px,calc(100% - 32px));margin:42px auto}.back{color:#62685f;text-decoration:none;font-weight:700}.card{background:#fff;border:1px solid #dfe3da;border-radius:22px;padding:26px;margin-top:18px}h1{margin:0 0 8px}p{color:#686f65;line-height:1.55}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}.box{border:1px solid #e5e8e1;border-radius:14px;padding:16px}.box h2{font-size:16px;margin:0 0 12px}dl{display:grid;grid-template-columns:1fr auto;gap:9px 12px;margin:0}dt{color:#62685f}dd{margin:0;font-weight:800}.danger{background:#fff5f4;border-color:#f0c8c3}.safe{background:#f4fbe8;border-color:#d8eabe}label{display:block;font-weight:700;margin-top:18px}input{display:block;width:100%;margin-top:7px;padding:12px;border:1px solid #dfe3da;border-radius:10px;font:inherit}.btn{border:0;border-radius:11px;background:#cf493f;color:#fff;padding:13px 18px;font-weight:800;cursor:pointer;margin-top:14px}.flash{padding:12px;border-radius:10px;background:#e5f4d8;color:#3d711e;margin:15px 0}.flash.error{background:#fde8e7;color:#9c2d27}@media(max-width:720px){.grid{grid-template-columns:1fr}}</style></head><body><main class="wrap"><a class="back" href="/platform/salons/${salon.id}">← Back to ${salon.name}</a><section class="card"><h1>Delivery reset for ${salon.name}</h1><p>This clears dummy operating data so the salon starts fresh. It keeps setup data: services/menu, staff, products, packages, users, settings, branding, WhatsApp, and the salon workspace.</p>{%FLASHES%}<div class="grid"><div class="box danger"><h2>Will be cleared</h2><dl>${removable.map(k=>`<dt>${k.replaceAll('_',' ')}</dt><dd>${counts[k]}</dd>`).join('')}</dl></div><div class="box safe"><h2>Will be kept</h2><dl>${kept.map(k=>`<dt>${k.replace('_kept','').replaceAll('_',' ')}</dt><dd>${counts[k]}</dd>`).join('')}</dl></div></div><form method="post"><label>Type DELIVER to permanently clear dummy data<input required name="confirm" autocomplete="off" placeholder="DELIVER"></label><button class="btn">Clear dummy data for delivery</button></form></section></main></body></html>`.replace('{%FLASHES%}',(res.locals.flashes||[]).map(([cat,msg])=>`<div class="flash ${cat}">${msg}</div>`).join('')));
  }));
  app.post('/platform/salons/:id/delivery-reset',platformAuth,asyncRoute(async(req,res)=>{
    const id=Number(req.params.id),context=await deliveryResetContext(id);if(!context)return res.status(404).send('Salon not found');
    if(String(req.body.confirm||'').trim()!=='DELIVER'){req.flash('error','Type DELIVER exactly to confirm the delivery reset.');return res.redirect(`/platform/salons/${id}/delivery-reset`);}
    await db.transaction(async connection=>{
      await connection.execute('DELETE FROM whatsapp_webhook_events WHERE salon_id=?',[id]);
      await connection.execute('DELETE FROM password_reset_tokens WHERE salon_id=?',[id]);
      await connection.execute('DELETE FROM appointments WHERE salon_id=?',[id]);
      await connection.execute('DELETE FROM loyalty_transactions WHERE salon_id=?',[id]);
      await connection.execute('DELETE FROM referral_credit_transactions WHERE salon_id=?',[id]);
      await connection.execute('DELETE FROM sale_items WHERE salon_id=?',[id]);
      await connection.execute('DELETE FROM sales WHERE salon_id=?',[id]);
      await connection.execute('DELETE FROM expenses WHERE salon_id=?',[id]);
      await connection.execute('DELETE FROM customers WHERE salon_id=?',[id]);
      await connection.execute('DELETE FROM audit_logs WHERE salon_id=?',[id]);
      await connection.execute('INSERT INTO audit_logs(salon_id,user_id,action,target_type,target_id,details,ip_address) VALUES(?,NULL,?,?,?,?,?)',[id,'platform.delivery_reset','salon',id,`Delivery reset completed for ${context.salon.name}`,req.ip||null]);
    });
    req.flash('success',`${context.salon.name} is cleared for delivery. Services/menu, users, staff, products, packages, settings and WhatsApp configuration were kept.`);
    res.redirect(`/platform/salons/${id}/delivery-reset`);
  }));
  app.post('/platform/salons/:id/status',platformAuth,asyncRoute(async(req,res)=>{
    const status=req.body.status==='Active'?'Active':'Suspended';
    await db.rows('UPDATE salons SET status=:status WHERE id=:id',{status,id:Number(req.params.id)});req.flash('success',`Salon access ${status==='Active'?'restored':'suspended'}.`);res.redirect('/platform');
  }));
  app.post('/platform/salons/:id/access',platformAuth,asyncRoute(async(req,res)=>{
    const id=Number(req.params.id),paymentStatus=['Pending','Paid','Overdue','Waived'].includes(req.body.payment_status)?req.body.payment_status:'Pending';
    const accessEnds=String(req.body.access_ends_at||'').trim()||null,paymentNotes=String(req.body.payment_notes||'').trim().slice(0,500)||null;
    await db.rows('UPDATE salons SET payment_status=:paymentStatus,payment_notes=:paymentNotes,access_ends_at=:accessEnds WHERE id=:id',{paymentStatus,paymentNotes,accessEnds,id});
    req.flash('success','Manual payment and access period updated.');res.redirect('/platform');
  }));
};
