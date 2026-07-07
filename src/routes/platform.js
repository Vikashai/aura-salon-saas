'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { rateLimit } = require('express-rate-limit');
const db = require('../db');
const { asyncRoute } = require('../helpers');

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
    const [applications,salons]=await Promise.all([db.rows('SELECT * FROM salon_applications ORDER BY id DESC'),db.rows('SELECT * FROM salons ORDER BY id DESC')]);
    res.render('platform_dashboard.html',{applications,salons,platform_admin:req.session.platformAdmin});
  }));
  app.post('/platform/applications/:id/approve',platformAuth,asyncRoute(async(req,res)=>{
    const id=Number(req.params.id),application=await db.one("SELECT * FROM salon_applications WHERE id=:id AND status='New'",{id});
    if(!application){req.flash('error','This application is no longer awaiting review.');return res.redirect('/platform');}
    const slug=await uniqueSlug(application.salon_name);
    const temporaryPassword=crypto.randomBytes(9).toString('base64url');
    const passwordHash=await bcrypt.hash(temporaryPassword,12),ownerUsername=`${slug}-owner`.slice(0,100);
    const result=await db.transaction(async connection=>{
      const [salon]=await connection.execute("INSERT INTO salons(name,slug,status,owner_name,owner_email,owner_mobile,approved_at) VALUES(?,?,'Active',?,?,?,NOW())",[application.salon_name,slug,application.owner_name,application.email,application.mobile]);
      await connection.execute("UPDATE salon_applications SET status='Approved',salon_id=?,reviewed_at=NOW() WHERE id=?",[salon.insertId,id]);return salon;
    });
    await db.transaction(async connection=>{
      await connection.execute("INSERT INTO capacity_pools(salon_id,name,seats,is_default) VALUES(?,'General',1,1)",[result.insertId]);
      await connection.execute("INSERT INTO settings(salon_id,`key`,`value`) SELECT ?,`key`,`value` FROM settings WHERE salon_id=(SELECT MIN(id) FROM salons WHERE status='Active') ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)",[result.insertId]);
      await connection.execute("INSERT INTO users(salon_id,name,username,password_hash,role,status,force_password_change) VALUES(?,?,?,?, 'owner','Active',1)",[result.insertId,application.owner_name,ownerUsername,passwordHash]);
    });
    req.flash('success',`${application.salon_name} approved. Workspace: ${slug}; owner username: ${ownerUsername}; temporary password: ${temporaryPassword}`);res.redirect('/platform');
  }));
  app.post('/platform/applications/:id/reject',platformAuth,asyncRoute(async(req,res)=>{
    await db.rows("UPDATE salon_applications SET status='Rejected',reviewed_at=NOW() WHERE id=:id AND status='New'",{id:Number(req.params.id)});req.flash('success','Application rejected.');res.redirect('/platform');
  }));
  app.post('/platform/salons/:id/status',platformAuth,asyncRoute(async(req,res)=>{
    const status=req.body.status==='Active'?'Active':'Suspended';
    await db.rows('UPDATE salons SET status=:status WHERE id=:id',{status,id:Number(req.params.id)});req.flash('success',`Salon access ${status==='Active'?'restored':'suspended'}.`);res.redirect('/platform');
  }));
};
