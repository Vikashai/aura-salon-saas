'use strict';

const db = require('./db');
const { isoDate } = require('./helpers');

const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const STATUSES = ['Present','Absent','Half Day','Leave','Weekly Off'];

function dateFrom(value) {
  return new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
}

function addDays(value, days) {
  const date = dateFrom(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  const days = [];
  let cursor = String(start).slice(0, 10);
  const last = String(end).slice(0, 10);
  for (let guard = 0; cursor <= last && guard < 370; guard++) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

function monthBounds(value = isoDate()) {
  const date = dateFrom(value);
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { start, end };
}

function minutesBetween(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = String(start).slice(0, 5).split(':').map(Number);
  const [eh, em] = String(end).slice(0, 5).split(':').map(Number);
  if (![sh, sm, eh, em].every(Number.isFinite)) return 0;
  const diff = eh * 60 + em - (sh * 60 + sm);
  return diff > 0 ? diff : 0;
}

function weekdayName(date) {
  return WEEKDAYS[dateFrom(date).getUTCDay()];
}

function isWeeklyOff(staff, date) {
  return staff.weekly_off_day && staff.weekly_off_day === weekdayName(date);
}

function blankCounts() {
  return { present:0, absent:0, half_day:0, leave:0, weekly_off:0, not_marked:0, paid_days:0, expected_working_days:0, total_minutes:0, overtime_minutes:0 };
}

function applyStatus(summary, staff, date, attendance) {
  const autoWeeklyOff = !attendance && isWeeklyOff(staff, date);
  const status = attendance?.status || (autoWeeklyOff ? 'Weekly Off' : 'Not Marked');
  if (status === 'Present') { summary.present++; summary.paid_days += 1; summary.expected_working_days += 1; }
  else if (status === 'Half Day') { summary.half_day++; summary.paid_days += 0.5; summary.expected_working_days += 1; }
  else if (status === 'Absent') { summary.absent++; summary.expected_working_days += 1; }
  else if (status === 'Leave') { summary.leave++; summary.expected_working_days += 1; }
  else if (status === 'Weekly Off') summary.weekly_off++;
  else { summary.not_marked++; summary.expected_working_days += 1; }
  const workedMinutes = minutesBetween(attendance?.check_in, attendance?.check_out);
  summary.total_minutes += workedMinutes;
  const standardMinutes = Math.max(Number(staff.standard_daily_hours || 8), 0) * 60;
  if (workedMinutes > 0 && status === 'Weekly Off') summary.overtime_minutes += workedMinutes;
  else if (workedMinutes > standardMinutes && ['Present','Half Day'].includes(status)) summary.overtime_minutes += workedMinutes - standardMinutes;
  return status;
}

function suggestedAmount(staff, summary) {
  const salary = Number(staff.fixed_salary || 0);
  if (salary <= 0 || summary.expected_working_days <= 0) return 0;
  return Math.round((salary * summary.paid_days / summary.expected_working_days) * 100) / 100;
}

async function summariesForPeriod(salonId, start, end, ids = []) {
  const staff = await db.rows(`SELECT id,name,role,fixed_salary,weekly_off_day,standard_daily_hours,overtime_hourly_rate FROM staff
    WHERE salon_id=:salonId AND archived=0 AND status='Active'
    ORDER BY name`, { salonId });
  const allowed = new Set(ids.map(Number).filter(Number.isInteger));
  const selected = allowed.size ? staff.filter(person => allowed.has(Number(person.id))) : staff;
  const attendance = await db.rows(`SELECT * FROM staff_attendance
    WHERE salon_id=:salonId AND attendance_date BETWEEN :start AND :end`, { salonId, start, end });
  const byStaffDate = new Map(attendance.map(row => [`${row.staff_id}:${String(row.attendance_date).slice(0, 10)}`, row]));
  const dates = daysBetween(start, end);
  return selected.map(person => {
    const summary = blankCounts();
    for (const date of dates) applyStatus(summary, person, date, byStaffDate.get(`${person.id}:${date}`));
    return {
      ...person,
      ...summary,
      total_hours: Math.round(summary.total_minutes / 60 * 100) / 100,
      overtime_hours: Math.round(summary.overtime_minutes / 60 * 100) / 100,
      overtime_amount: Math.round((summary.overtime_minutes / 60) * Number(person.overtime_hourly_rate || 0) * 100) / 100,
      suggested_amount: suggestedAmount(person, summary),
      period_start: start,
      period_end: end,
    };
  });
}

module.exports = { WEEKDAYS, STATUSES, daysBetween, monthBounds, weekdayName, isWeeklyOff, applyStatus, summariesForPeriod };
