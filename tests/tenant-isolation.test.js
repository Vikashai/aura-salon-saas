'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assertTenantScoped}=require('../src/db');

test('rejects an unscoped salon-owned read',()=>{
  assert.throws(()=>assertTenantScoped('SELECT * FROM customers WHERE archived=0'),/missing salon_id/);
});

test('accepts an explicitly tenant-scoped read',()=>{
  assert.doesNotThrow(()=>assertTenantScoped('SELECT * FROM customers WHERE salon_id=:salonId AND archived=0'));
});

test('does not require tenant scope for control-plane tables',()=>{
  assert.doesNotThrow(()=>assertTenantScoped('SELECT * FROM salons ORDER BY id'));
});
