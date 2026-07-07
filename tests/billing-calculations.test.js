'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateBaseTotals, applyRewards, paymentFromForm } = require('../src/billing-calculations');

test('calculates discount then GST with currency rounding', () => {
  assert.deepEqual(calculateBaseTotals({subtotal:1000,discount:100,gstEnabled:true,gstPercent:18}),{subtotal:1000,discount:100,gstPercent:18,tax:162,beforeRewards:1062});
});
test('caps excessive discounts and never creates negative GST', () => {
  assert.deepEqual(calculateBaseTotals({subtotal:500,discount:900,gstEnabled:true,gstPercent:18}),{subtotal:500,discount:500,gstPercent:18,tax:0,beforeRewards:0});
});
test('applies rewards sequentially without making a negative bill', () => {
  assert.deepEqual(applyRewards(150,50,100,200),{loyaltyDiscount:50,referralDiscount:100,referralCreditUsed:0,finalAmount:0});
});
test('totals a valid split payment', () => {
  assert.deepEqual(paymentFromForm({split_payment_mode:['UPI','Cash'],split_payment_amount:['400','600']},1000),{paid:1000,mode:'UPI ₹400.00 + Cash ₹600.00'});
});
test('rejects payment above the invoice total', () => {
  assert.ok(paymentFromForm({paid_amount:'1001',payment_mode:'Cash'},1000).error);
});
