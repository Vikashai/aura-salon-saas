'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');

const views = path.join(__dirname, '..', 'views');
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(views));
env.addFilter('money', value => `₹${Number(value || 0)}`);
env.addFilter('fmt_time', value => value || '');
env.addFilter('mmdd', value => value || '—');
env.addFilter('int', value => Number.parseInt(value || 0, 10));
env.addFilter('trim', value => String(value || '').trim());

for (const file of fs.readdirSync(views).filter(name => name.endsWith('.html'))) {
  test(`template parses: ${file}`, () => {
    const template = env.getTemplate(file, true);
    assert.ok(template);
  });
}

test('all templates render with an empty-state context', () => {
  const get = (key, fallback = '') => fallback;
  const context = {
    request: { path: '/', args: { get } }, current_user: { name: 'Admin', role: 'owner', is_authenticated: true }, can: () => true,
    flashes: [], cfg: { get }, data: { get }, settings: { get }, today: new Date(), today_display: 'July 06, 2026',
    current_year: 2026, today_day: 'Monday', q: '', start: '2026-06-01', end: '2026-07-01',
    status_f: '', date_f: '', date_from: '', date_to: '', title: 'Records', singular: 'Record', fields: [], labels: [], module: 'services',
    rows: [], recent: [], customers: [], staff: [], services: [], items: [], bills: [], appts: [],
    low: [], top_services: [], upcoming: [], today_list: [], loyalty_txns: [], leaderboard: [], recent_txns: [],
    referral_pairs: [], birthdays_today: [], anniversaries_today: [], upcoming_birthdays: [], upcoming_anniversaries: [],
    modes: [], revenue: 0, expenses: 0, pending: 0, spent: 0, loyalty_balance: 0, capacity_pools: [], group: [], total: 0,
    stats: {}, loyalty_cfg: { enabled: false, redeem_rate: 100 }, sale: {}, row: {}, appt: {}, already_done: false,
  };
  for (const file of fs.readdirSync(views).filter(name => name.endsWith('.html'))) {
    assert.doesNotThrow(() => env.render(file, context), file);
  }
});
