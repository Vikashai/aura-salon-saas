'use strict';

const money = value => Math.round((Number(value) || 0) * 100) / 100;

function calculateBaseTotals({ subtotal, discount, gstEnabled, gstPercent }) {
  const safeSubtotal = Math.max(money(subtotal), 0);
  const safeDiscount = Math.min(Math.max(money(discount), 0), safeSubtotal);
  const safeGstPercent = gstEnabled ? Math.min(Math.max(Number(gstPercent) || 0, 0), 100) : 0;
  const taxable = money(safeSubtotal - safeDiscount);
  const tax = money(taxable * safeGstPercent / 100);
  return { subtotal:safeSubtotal, discount:safeDiscount, gstPercent:safeGstPercent, tax, beforeRewards:money(taxable + tax) };
}

function applyRewards(beforeRewards, loyaltyDiscount, referralDiscount, referralCreditUsed) {
  let remaining = Math.max(money(beforeRewards), 0);
  const loyalty = Math.min(Math.max(money(loyaltyDiscount), 0), remaining); remaining = money(remaining - loyalty);
  const referral = Math.min(Math.max(money(referralDiscount), 0), remaining); remaining = money(remaining - referral);
  const credit = Math.min(Math.max(money(referralCreditUsed), 0), remaining); remaining = money(remaining - credit);
  return { loyaltyDiscount:loyalty, referralDiscount:referral, referralCreditUsed:credit, finalAmount:remaining };
}

function paymentFromForm(body, finalAmount) {
  const array = value => Array.isArray(value) ? value : value == null ? [] : [value];
  const splitModes = array(body.split_payment_mode).map(value => String(value || '').trim());
  const splitAmounts = array(body.split_payment_amount);
  const split = splitModes.map((mode, index) => ({ mode, amount:money(splitAmounts[index]) }))
    .filter(entry => entry.mode && Number.isFinite(entry.amount) && entry.amount > 0);
  const usingSplit = split.length > 0;
  const paid = money(usingSplit ? split.reduce((sum, entry) => sum + entry.amount, 0) : body.paid_amount);
  const mode = usingSplit ? split.map(entry => `${entry.mode} ₹${entry.amount.toFixed(2)}`).join(' + ') : String(body.payment_mode || '').trim();
  if (!Number.isFinite(paid) || paid < 0) return { error:'Enter a valid amount received.' };
  if (!mode) return { error:'Select a payment mode.' };
  if (paid > money(finalAmount) + 0.009) return { error:'Amount received cannot be more than the final bill amount.' };
  if (usingSplit && split.length < 2) return { error:'Enter both parts of the split payment.' };
  return { paid, mode };
}

module.exports = { money, calculateBaseTotals, applyRewards, paymentFromForm };
