'use strict';
require('dotenv').config();
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const MySQLSession = require('express-mysql-session')(session);
const nunjucks = require('nunjucks');
const { money, fmtTime, mmdd, isoDate } = require('./helpers');
const db = require('./db');
const { accessMiddleware } = require('./access');
const registerRoutes = require('./routes');

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is required');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
const env = nunjucks.configure(path.join(__dirname, '..', 'views'), { autoescape: true, express: app, noCache: process.env.NODE_ENV !== 'production' });
env.addFilter('money', money);
env.addFilter('fmt_time', fmtTime);
env.addFilter('mmdd', mmdd);
env.addFilter('int', value => Number.parseInt(value || 0, 10));
env.addFilter('float', value => Number.parseFloat(value || 0));
env.addFilter('trim', value => String(value || '').trim());
env.addFilter('dateonly', value => value ? isoDate(new Date(value)) : '');
function brandContrast(value) {
  const match=String(value||'').match(/^#([0-9a-f]{6})$/i);if(!match)return'#20211f';
  const hex=match[1],channels=[0,2,4].map(index=>parseInt(hex.slice(index,index+2),16)/255).map(channel=>channel<=.03928?channel/12.92:((channel+.055)/1.055)**2.4);
  return .2126*channels[0]+.7152*channels[1]+.0722*channels[2]>.42?'#20211f':'#ffffff';
}
env.addFilter('brand_contrast',brandContrast);
env.addFilter('brand_on_dark',value=>brandContrast(value)==='#ffffff'?'#ffffff':String(value||'#dfff3f'));
app.set('view engine', 'html');
app.use('/static', express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '1mb' }));

let databaseInitializationError = null;
const databaseReady = process.env.AUTO_INIT_DB === 'true'
  ? require('../scripts/init-db').main().catch(error => {
    databaseInitializationError = error;
    console.error('Database initialization failed:', error);
  })
  : Promise.resolve();

app.use(async (_req, _res, next) => {
  await databaseReady;
  return databaseInitializationError ? next(databaseInitializationError) : next();
});

app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || req.path.startsWith('/tasks/')) return next();
  const source = req.get('origin') || req.get('referer');
  if (!source) return next();
  // Some browsers/privacy extensions send an opaque origin for localhost forms.
  // Permit that only during local development; production remains strict.
  if (source === 'null' && process.env.NODE_ENV !== 'production') return next();
  try {
    if (new URL(source).host !== req.get('host')) return res.status(403).send('Cross-site request blocked');
  } catch { return res.status(403).send('Invalid request origin'); }
  return next();
});

const store = new MySQLSession({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, createDatabaseTable: true, charset: 'utf8mb4_bin',
});
app.use(session({
  name: 'aura.sid', secret: process.env.SESSION_SECRET || 'local-development-only', store,
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 28800000 },
}));
app.use(async (req,res,next) => {
  try {
    const slug=String(req.query.salon||req.body?.salon||req.session.user?.salon_slug||'').trim().toLowerCase();
    if (!slug) { req.salon=null; res.locals.salon=null; return next(); }
    const salon=await db.one("SELECT * FROM salons WHERE slug=:slug AND status='Active' AND (access_starts_at IS NULL OR access_starts_at<=NOW()) AND (access_ends_at IS NULL OR access_ends_at>=NOW())",{slug});
    if (!salon) return res.status(403).send('Salon access is unavailable.');
    req.salon=salon;res.locals.salon=salon;return next();
  } catch(error){return next(error);}
});
app.use((req, res, next) => {
  req.flash = (category, message) => { req.session.flashes ||= []; req.session.flashes.push([category, message]); };
  const args = { ...req.query, get: (key, fallback = '') => req.query[key] ?? fallback };
  res.locals.request = { path: req.path, args };
  res.locals.current_user = req.session.user ? { ...req.session.user, is_authenticated: true } : { name: 'Admin', role: '', is_authenticated: false };
  res.locals.flashes = req.session.flashes || [];
  delete req.session.flashes;
  res.locals.today = isoDate();
  next();
});
app.use(async (req, res, next) => {
  try {
    const settingsRows = req.salon ? await db.rows('SELECT `key`, `value` FROM settings WHERE salon_id=:salonId',{salonId:req.salon.id}) : [];
    const cfg = Object.fromEntries(settingsRows.map(row => [row.key, row.value]));
    const environmentOverrides = {
      meta_whatsapp_token: process.env.META_WHATSAPP_TOKEN,
      meta_phone_number_id: process.env.META_PHONE_NUMBER_ID,
      smtp_pass: process.env.SMTP_PASSWORD,
      twilio_token: process.env.TWILIO_AUTH_TOKEN,
    };
    for (const [key, value] of Object.entries(environmentOverrides)) if (value) cfg[key] = value;
    cfg.get = (key, fallback = '') => cfg[key] ?? fallback;
    if(req.salon)cfg.salon_slug=req.salon.slug;
    res.locals.cfg = cfg;
    req.settings = cfg;
    res.locals.salon_url = req.salon ? `?salon=${encodeURIComponent(req.salon.slug)}` : '';
    next();
  } catch (error) { next(error); }
});
app.use(accessMiddleware);
registerRoutes(app);
app.use((_req, res) => res.status(404).send('Page not found'));
app.use((error, req, res, _next) => {
  console.error(error);
  const message = process.env.NODE_ENV === 'production' ? 'Something went wrong.' : error.message;
  if (req.accepts('html')) return res.status(500).send(`<h1>Aura Salon OS</h1><p>${message}</p>`);
  return res.status(500).json({ error: message });
});
const port = Number(process.env.PORT || 3000);
if (require.main === module) {
  const start = async () => {
    await databaseReady;
    if (databaseInitializationError) throw databaseInitializationError;
    app.listen(port, '0.0.0.0', () => console.log(`Aura Salon OS running on port ${port}`));
  };
  start().catch(error => {
    console.error('Application startup failed:', error);
    process.exitCode = 1;
  });
}
module.exports = app;
