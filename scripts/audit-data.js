'use strict';
require('dotenv').config();
const db = require('../src/db');

async function main() {
  const checks = {
    invoice_total_mismatches: `SELECT COUNT(*) count FROM sales WHERE cancelled=0 AND ABS(final_amount-GREATEST(subtotal-discount+tax_amount-loyalty_discount-referral_discount-referral_credit_used,0))>0.01`,
    invoice_balance_mismatches: `SELECT COUNT(*) count FROM sales WHERE cancelled=0 AND ABS(pending_amount-GREATEST(final_amount-paid_amount,0))>0.01`,
    overpaid_invoices: `SELECT COUNT(*) count FROM sales WHERE cancelled=0 AND paid_amount>final_amount+0.01`,
    invalid_expenses: `SELECT COUNT(*) count FROM expenses WHERE amount IS NULL OR amount<=0`,
    invalid_appointments: `SELECT COUNT(*) count FROM appointments WHERE duration_mins IS NULL OR duration_mins<=0 OR amount<0`,
    orphaned_referrals: `SELECT COUNT(*) count FROM customers c LEFT JOIN customers r ON r.id=c.referred_by_id WHERE c.referred_by_id IS NOT NULL AND r.id IS NULL`,
    referral_ledger_mismatches: `SELECT COUNT(*) count FROM customers c LEFT JOIN (SELECT customer_id,SUM(amount) ledger FROM referral_credit_transactions GROUP BY customer_id) t ON t.customer_id=c.id WHERE ABS(c.referral_credit-COALESCE(t.ledger,0))>0.01`,
  };
  const result = {};
  for (const [name, sql] of Object.entries(checks)) result[name] = Number((await db.one(sql)).count);
  console.log(JSON.stringify(result, null, 2));
  await db.pool.end();
  if (Object.values(result).some(Boolean)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
