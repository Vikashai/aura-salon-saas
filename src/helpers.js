'use strict';

function money(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function fmtTime(value) {
  if (!value) return '';
  const [hour, minute] = String(value).slice(0, 5).split(':').map(Number);
  if (!Number.isFinite(hour)) return value;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

function mmdd(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' })
    .format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`));
}

function isoDate(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function toMinutes(time) {
  const [hour, minute] = String(time || '0:0').split(':').map(Number);
  return hour * 60 + minute;
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { money, fmtTime, mmdd, isoDate, toMinutes, firstName, asyncRoute };
