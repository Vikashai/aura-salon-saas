'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { progressiveCommission }=require('../src/commission-service');

test('calculates progressive staff commission slabs',()=>{
  const result=progressiveCommission(40000,[
    {threshold_amount:0,rate_percent:5},
    {threshold_amount:25000,rate_percent:10},
  ]);
  assert.equal(result.amount,2750);
  assert.deepEqual(result.slabs,[
    {from:0,to:25000,applied:25000,rate_percent:5,commission:1250},
    {from:25000,to:null,applied:15000,rate_percent:10,commission:1500},
  ]);
});

test('ignores slabs above the sales total',()=>{
  const result=progressiveCommission(10000,[
    {threshold_amount:0,rate_percent:5},
    {threshold_amount:25000,rate_percent:10},
  ]);
  assert.equal(result.amount,500);
  assert.equal(result.slabs.length,1);
});
