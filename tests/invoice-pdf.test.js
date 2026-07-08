'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {generateInvoicePdf}=require('../src/invoice-pdf');

test('generates a valid invoice PDF buffer',async()=>{
  const pdf=await generateInvoicePdf({invoice_no:'INV-TEST',invoice_date:'2026-07-08',customer:'Demo Customer',mobile:'9999999999',payment_mode:'Cash',payment_status:'Paid',subtotal:500,discount:0,gst_enabled:0,final_amount:500,paid_amount:500,pending_amount:0},[{item_name:'Haircut',item_type:'Service',quantity:1,price:500,discount:0,staff_name:'Stylist'}],{salon_name:'Aura Demo Salon'});
  assert.equal(pdf.subarray(0,4).toString(),'%PDF');
  assert.ok(pdf.length>1000);
});
