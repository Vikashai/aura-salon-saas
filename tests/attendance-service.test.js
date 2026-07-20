'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { applyStatus }=require('../src/attendance-service');

test('calculates overtime after standard hours',()=>{
  const summary={present:0,absent:0,half_day:0,leave:0,weekly_off:0,not_marked:0,paid_days:0,expected_working_days:0,total_minutes:0,overtime_minutes:0};
  applyStatus(summary,{standard_daily_hours:8,weekly_off_day:'Sunday'},'2026-07-20',{status:'Present',check_in:'09:00',check_out:'18:30'});
  assert.equal(summary.total_minutes,570);
  assert.equal(summary.overtime_minutes,90);
});

test('counts weekly off work fully as overtime',()=>{
  const summary={present:0,absent:0,half_day:0,leave:0,weekly_off:0,not_marked:0,paid_days:0,expected_working_days:0,total_minutes:0,overtime_minutes:0};
  applyStatus(summary,{standard_daily_hours:8,weekly_off_day:'Sunday'},'2026-07-19',{status:'Weekly Off',check_in:'10:00',check_out:'14:00'});
  assert.equal(summary.weekly_off,1);
  assert.equal(summary.total_minutes,240);
  assert.equal(summary.overtime_minutes,240);
});
