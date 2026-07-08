'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { rateLimit } = require('express-rate-limit');
const db = require('../db');
const { asyncRoute } = require('../helpers');
const { sendPlatformEmail } = require('../notifications');

const platformAuth = (req,res,next) => req.session.platformAdmin ? next() : res.redirect('/platform/login');
const slugify = value => String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70) || 'salon';
async function uniqueSlug(name) {
  const base=slugify(name); let slug=base; let suffix=1;
  while(await db.one('SELECT id FROM salons WHERE slug=:slug',{slug})) slug=`${base}-${++suffix}`;
  return slug;
}

module.exports = app => {
  const limiter=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false});
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
    const admin=await db.one("SELECT * FROM platform_admins WHERE username=:username AND status='Active'",{username});
    if(admin&&await bcrypt.compare(String(req.body.password||''),admin.password_hash)){
      await new Promise((resolve,reject)=>req.session.regenerate(error=>error?reject(error):resolve()));
      req.session.platformAdmin={id:admin.id,name:admin.name,username:admin.username};
      await db.rows('UPDATE platform_admins SET last_login=NOW() WHERE id=:id',{id:admin.id});return res.redirect('/platform');
    }
    req.flash('error','Incorrect platform administrator credentials.');res.redirect('/platform/login');
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
    req.flash('success',`${application.salon_name} approved. Workspace: ${slug}; owner username: ${ownerUsername}; temporary password: ${temporaryPassword}`);res.redirect('/platform');
  }));
  app.post('/platform/applications/:id/reject',platformAuth,asyncRoute(async(req,res)=>{
    await db.rows("UPDATE salon_applications SET status='Rejected',reviewed_at=NOW() WHERE id=:id AND status='New'",{id:Number(req.params.id)});req.flash('success','Application rejected.');res.redirect('/platform');
  }));
  app.get('/platform/recovery',platformAuth,(req,res)=>res.render('platform_recovery.html',{platform_admin:req.session.platformAdmin}));
  app.post('/platform/recovery',platformAuth,asyncRoute(async(req,res)=>{
    const salonSlug=String(req.body.salon_slug||'').trim().toLowerCase(),username=String(req.body.username||'').trim().toLowerCase();
    const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');
    const user=await db.platformOne(`SELECT u.id,u.salon_id,u.username,s.name salon_name FROM users u JOIN salons s ON s.id=u.salon_id WHERE s.slug=? AND LOWER(u.username)=?`,[salonSlug,username]);
    if(!user||!/^\S+@\S+\.\S+$/.test(email)||password.length<8){req.flash('error','Enter a valid salon slug, username, email and temporary password of at least 8 characters.');return res.redirect('/platform/recovery');}
    const duplicate=await db.platformOne('SELECT id FROM users WHERE LOWER(email)=? AND id<>?',[email,user.id]);
    if(duplicate){req.flash('error','That email is already connected to another Aura user.');return res.redirect('/platform/recovery');}
    const passwordHash=await bcrypt.hash(password,12);
    await db.rows('UPDATE users SET email=:email,password_hash=:passwordHash,password_changed_at=NOW(),force_password_change=1 WHERE id=:id AND salon_id=:salonId',{email,passwordHash,id:user.id,salonId:user.salon_id});
    await db.rows('INSERT INTO audit_logs(salon_id,user_id,action,target_type,target_id,details,ip_address) VALUES(:salonId,NULL,:action,:targetType,:targetId,:details,:ip)',{salonId:user.salon_id,action:'platform.account_recovery',targetType:'user',targetId:user.id,details:`Company admin recovered ${user.username}`,ip:req.ip||null});
    req.flash('success',`Recovery details saved for ${user.username} at ${user.salon_name}.`);res.redirect('/platform/recovery');
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
