'use strict';
const crypto = require('node:crypto');
const db = require('../db');

function auth(req, res, next) {
  if (req.session.user) return next();
  req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
}

function loyaltyConfig(settings) {
  const number = (key, fallback) => Number(settings[key] ?? fallback);
  return {
    enabled: settings.loyalty_enabled !== '0', earn_rate: number('loyalty_earn_rate', 2),
    redeem_rate: number('loyalty_redeem_rate', 100), min_redeem: number('loyalty_min_redeem', 500),
    max_redeem_pct: number('loyalty_max_redeem_pct', 30), expiry_months: number('loyalty_expiry_months', 12),
    ref_referrer: number('loyalty_referral_referrer', 500), ref_referee: number('loyalty_referral_referee', 200),
    earn_services: settings.loyalty_earn_on_services !== '0', earn_products: settings.loyalty_earn_on_products !== '0',
  };
}

function referralConfig(settings) {
  return { referrer_credit:Number(settings.referral_referrer_credit ?? 200), referee_discount:Number(settings.referral_referee_discount ?? 100) };
}

async function adjustReferralCredit(connection, customerId, amount, type, description, refereeId = null, saleId = null) {
  await connection.execute('UPDATE customers SET referral_credit=GREATEST(referral_credit+?,0) WHERE id=?', [amount, customerId]);
  const [[customer]] = await connection.execute('SELECT referral_credit FROM customers WHERE id=?', [customerId]);
  await connection.execute('INSERT INTO referral_credit_transactions(customer_id,referee_id,sale_id,type,amount,balance_after,description) VALUES(?,?,?,?,?,?,?)',[customerId,refereeId,saleId,type,amount,customer.referral_credit,description]);
}

async function awardPoints(connection, customerId, points, type, description, refType = null, refId = null) {
  await connection.execute('UPDATE customers SET loyalty_points=loyalty_points+? WHERE id=?', [points, customerId]);
  const [[customer]] = await connection.execute('SELECT loyalty_points FROM customers WHERE id=?', [customerId]);
  await connection.execute(
    'INSERT INTO loyalty_transactions(customer_id,type,points,balance_after,description,ref_type,ref_id) VALUES(?,?,?,?,?,?,?)',
    [customerId, type, points, customer.loyalty_points, description, refType, refId],
  );
  return customer.loyalty_points;
}

async function referralCode() {
  for (;;) {
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    if (!await db.one('SELECT id FROM customers WHERE referral_code=:code', { code })) return code;
  }
}

module.exports = { auth, loyaltyConfig, referralConfig, awardPoints, adjustReferralCredit, referralCode };
