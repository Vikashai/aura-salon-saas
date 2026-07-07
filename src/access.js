'use strict';
const db = require('./db');

const MODULES = ['dashboard','appointments','customers','billing','services','team','inventory','packages','expenses','reports','loyalty','greetings','settings','users'];
const all = () => MODULES.flatMap(module => [`${module}.view`,`${module}.manage`]);
const ROLE_PERMISSIONS = {
  owner: all(),
  admin: all(),
  manager: all().filter(permission => !permission.startsWith('users.') && !permission.startsWith('settings.')),
  receptionist: ['dashboard.view','appointments.view','appointments.manage','customers.view','customers.manage','billing.view','billing.manage','services.view','team.view','inventory.view','packages.view'],
  team: ['dashboard.view','appointments.view','customers.view','services.view','team.view'],
  custom: [],
};

function normalizeRole(role) { const value=String(role||'').toLowerCase();return ROLE_PERMISSIONS[value]?value:'custom'; }
function permissionsFor(user) {
  const role=normalizeRole(user?.role);if(role!=='custom')return new Set(ROLE_PERMISSIONS[role]);
  try{return new Set(Array.isArray(user?.permissions)?user.permissions:JSON.parse(user?.permissions||'[]'));}catch{return new Set();}
}
function can(user, permission) { const permissions=permissionsFor(user);return normalizeRole(user?.role)==='owner'||permissions.has(permission)||(permission.endsWith('.view')&&permissions.has(permission.replace('.view','.manage'))); }

function routePermission(req) {
  const path=req.path,manage=req.method!=='GET'||/\/(new|edit)(\/|$)/.test(path)||/\/send\/|\/archive$|\/status$|\/bulk$|\/import$/.test(path);
  if(path==='/')return'dashboard.view';
  if(path.startsWith('/users')||path.startsWith('/change-password'))return path.startsWith('/users')?'users.manage':null;
  if(path.startsWith('/appointments')||path.startsWith('/api/slots'))return`appointments.${manage?'manage':'view'}`;
  if(path.startsWith('/customers'))return`customers.${manage?'manage':'view'}`;
  if(path.startsWith('/billing')||path.startsWith('/api/loyalty')||path.startsWith('/api/referral'))return`billing.${manage?'manage':'view'}`;
  const management={services:'services',staff:'team',inventory:'inventory',packages:'packages',expenses:'expenses'};
  const match=path.match(/^\/manage\/([^/]+)/);if(match&&management[match[1]])return`${management[match[1]]}.${manage?'manage':'view'}`;
  if(path.startsWith('/reports'))return'reports.view';
  if(path.startsWith('/loyalty'))return`loyalty.${manage?'manage':'view'}`;
  if(path.startsWith('/greetings'))return`greetings.${manage?'manage':'view'}`;
  if(path.startsWith('/settings'))return`settings.${manage?'manage':'view'}`;
  return null;
}

async function accessMiddleware(req,res,next){
  if(!req.session.user)return next();
  try{
    const user=await db.one('SELECT * FROM users WHERE id=:id',{id:req.session.user.id});
    if(!user||user.status!=='Active'){return req.session.destroy(()=>res.redirect('/login'));}
    user.role=normalizeRole(user.role);req.user=user;req.session.user={id:user.id,name:user.name,username:user.username,role:user.role,staff_id:user.staff_id||null};
    res.locals.current_user={...req.session.user,is_authenticated:true};res.locals.can=permission=>can(user,permission);
    if(user.force_password_change&&!['/change-password','/logout'].includes(req.path))return res.redirect('/change-password');
    const permission=routePermission(req);if(permission&&!can(user,permission))return res.status(403).render('access_denied.html',{permission});
    if(Date.now()-new Date(user.last_activity||0).getTime()>60000)db.rows('UPDATE users SET last_activity=NOW() WHERE id=:id',{id:user.id}).catch(()=>{});
    return next();
  }catch(error){return next(error);}
}

async function audit(userId,action,targetType,targetId,details,req){
  await db.rows('INSERT INTO audit_logs(user_id,action,target_type,target_id,details,ip_address) VALUES(:userId,:action,:targetType,:targetId,:details,:ip)',{userId:userId||null,action,targetType,targetId:targetId||null,details:details||null,ip:req?.ip||null});
}

module.exports={MODULES,ROLE_PERMISSIONS,normalizeRole,permissionsFor,can,accessMiddleware,audit};
