'use strict';

const db = require('./db');

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

function progressiveCommission(totalSales, rules) {
  const sales = Math.max(roundMoney(totalSales), 0);
  const sorted = [...rules]
    .map(rule => ({ threshold_amount:roundMoney(rule.threshold_amount), rate_percent:Number(rule.rate_percent || 0) }))
    .filter(rule => rule.threshold_amount >= 0 && rule.rate_percent >= 0)
    .sort((a,b) => a.threshold_amount - b.threshold_amount);
  if (!sorted.length || sales <= 0) return { sales, amount:0, slabs:[] };
  const slabs = [];
  for (let index = 0; index < sorted.length; index++) {
    const current = sorted[index], next = sorted[index + 1];
    if (sales <= current.threshold_amount) continue;
    const upper = next ? Math.min(sales, next.threshold_amount) : sales;
    const applied = roundMoney(upper - current.threshold_amount);
    if (applied <= 0) continue;
    const commission = roundMoney(applied * current.rate_percent / 100);
    slabs.push({ from:current.threshold_amount, to:next?.threshold_amount ?? null, applied, rate_percent:current.rate_percent, commission });
  }
  return { sales, amount:roundMoney(slabs.reduce((sum, slab) => sum + slab.commission, 0)), slabs };
}

async function commissionForPeriod(salonId, start, end, ids = []) {
  const staff = await db.rows(`SELECT id,name,role FROM staff
    WHERE salon_id=:salonId AND archived=0 AND status='Active'
    ORDER BY name`, { salonId });
  const allowed = new Set(ids.map(Number).filter(Number.isInteger));
  const selected = allowed.size ? staff.filter(person => allowed.has(Number(person.id))) : staff;
  const [rules, salesRows] = await Promise.all([
    db.rows('SELECT staff_id,threshold_amount,rate_percent FROM staff_commission_rules WHERE salon_id=:salonId ORDER BY staff_id,threshold_amount', { salonId }),
    db.rows(`SELECT st.id staff_id,COALESCE(revenue.sales,0) sales
      FROM staff st
      LEFT JOIN (
        SELECT COALESCE(si.staff_id,st2.id) staff_id,COALESCE(SUM(si.quantity*si.price-si.discount),0) sales
        FROM sale_items si
        JOIN sales s ON s.id=si.sale_id AND s.salon_id=si.salon_id
        LEFT JOIN staff st2 ON st2.salon_id=si.salon_id AND si.staff_id IS NULL AND si.staff_name=st2.name
        WHERE si.salon_id=:salonId AND s.cancelled=0 AND s.invoice_date BETWEEN :start AND :end
        GROUP BY COALESCE(si.staff_id,st2.id)
      ) revenue ON revenue.staff_id=st.id
      WHERE st.salon_id=:salonId AND st.archived=0 AND st.status='Active'`, { salonId, start, end }),
  ]);
  const rulesByStaff = new Map();
  for (const rule of rules) {
    const key = Number(rule.staff_id);
    if (!rulesByStaff.has(key)) rulesByStaff.set(key, []);
    rulesByStaff.get(key).push(rule);
  }
  const salesByStaff = new Map(salesRows.map(row => [Number(row.staff_id), roundMoney(row.sales)]));
  return selected.map(person => {
    const calc = progressiveCommission(salesByStaff.get(Number(person.id)) || 0, rulesByStaff.get(Number(person.id)) || []);
    return { ...person, commission_sales:calc.sales, commission_amount:calc.amount, commission_slabs:calc.slabs, commission_rules:rulesByStaff.get(Number(person.id)) || [] };
  });
}

module.exports = { progressiveCommission, commissionForPeriod };
