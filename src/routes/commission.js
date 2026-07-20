'use strict';

const db = require('../db');
const { asyncRoute } = require('../helpers');
const { auth } = require('./shared');
const { audit } = require('../access');

function commissionAuth(req, res, next) {
  if (!['owner','manager'].includes(req.user?.role)) return res.status(403).render('access_denied.html', { permission:'commission.manage' });
  return next();
}

function values(body, key) {
  const value = body[key];
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

module.exports = app => {
  app.get('/commission', auth, commissionAuth, asyncRoute(async(req,res) => {
    const salonId=req.user.salon_id;
    const [staff,rules]=await Promise.all([
      db.rows("SELECT id,name,role FROM staff WHERE salon_id=:salonId AND archived=0 AND status='Active' AND name IS NOT NULL AND TRIM(name)<>'' ORDER BY name",{salonId}),
      db.rows('SELECT * FROM staff_commission_rules WHERE salon_id=:salonId ORDER BY staff_id,threshold_amount',{salonId}),
    ]);
    const rulesByStaff=new Map();
    for(const rule of rules){const key=Number(rule.staff_id);if(!rulesByStaff.has(key))rulesByStaff.set(key,[]);rulesByStaff.get(key).push(rule);}
    res.render('commission.html',{staff:staff.map(person=>({...person,rules:rulesByStaff.get(Number(person.id))||[]}))});
  }));

  app.post('/commission/:staffId', auth, commissionAuth, asyncRoute(async(req,res) => {
    const salonId=req.user.salon_id,staffId=Number(req.params.staffId),person=await db.one('SELECT id,name FROM staff WHERE id=:staffId AND salon_id=:salonId AND archived=0',{staffId,salonId});
    if(!person)return res.status(404).send('Staff not found');
    const staffName=String(person.name||'').trim()||`Team member #${staffId}`;
    const thresholds=values(req.body,'threshold_amount'),rates=values(req.body,'rate_percent'),rules=[];
    for(let index=0;index<thresholds.length;index++){
      const threshold=Math.round(Number(thresholds[index]||0)*100)/100,rate=Math.round(Number(rates[index]||0)*100)/100;
      if(!Number.isFinite(threshold)||!Number.isFinite(rate)||threshold<0||rate<0)continue;
      if(rate===0&&threshold>0)continue;
      rules.push({threshold,rate});
    }
    if(!rules.some(rule=>rule.threshold===0))rules.unshift({threshold:0,rate:0});
    const unique=[...new Map(rules.sort((a,b)=>a.threshold-b.threshold).map(rule=>[rule.threshold,rule])).values()];
    await db.transaction(async connection=>{
      await connection.execute('DELETE FROM staff_commission_rules WHERE salon_id=? AND staff_id=?',[salonId,staffId]);
      for(const rule of unique)await connection.execute('INSERT INTO staff_commission_rules(salon_id,staff_id,threshold_amount,rate_percent) VALUES(?,?,?,?)',[salonId,staffId,rule.threshold,rule.rate]);
    });
    await audit(req.user.id,'commission.updated','staff',staffId,`Updated commission rules for ${staffName}`,req);
    req.flash('success',`Commission rules saved for ${staffName}.`);
    res.redirect('/commission');
  }));
};
