'use strict';

const db = require('../db');
const { asyncRoute, isoDate } = require('../helpers');
const { auth } = require('./shared');
const { audit } = require('../access');
const { WEEKDAYS, STATUSES, monthBounds, isWeeklyOff, summariesForPeriod } = require('../attendance-service');

function attendanceAuth(req, res, next) {
  if (!['owner','manager'].includes(req.user?.role)) return res.status(403).render('access_denied.html', { permission:'attendance.manage' });
  return next();
}

function cleanTime(value) {
  const text = String(value || '').trim();
  return /^\d{2}:\d{2}$/.test(text) ? text : null;
}

function monthRange(query) {
  const bounds = monthBounds(query.month ? `${query.month}-01` : isoDate());
  const start = String(query.start || bounds.start).slice(0, 10);
  const end = String(query.end || bounds.end).slice(0, 10);
  return start <= end ? { start, end } : bounds;
}

module.exports = app => {
  app.get('/attendance', auth, attendanceAuth, asyncRoute(async(req,res) => {
    const salonId = req.user.salon_id;
    const date = String(req.query.date || isoDate()).slice(0, 10);
    const { start, end } = monthRange(req.query);
    const [staff, attendanceRows, monthly] = await Promise.all([
      db.rows("SELECT id,name,role,weekly_off_day FROM staff WHERE salon_id=:salonId AND archived=0 AND status='Active' ORDER BY name", { salonId }),
      db.rows('SELECT * FROM staff_attendance WHERE salon_id=:salonId AND attendance_date=:date', { salonId, date }),
      summariesForPeriod(salonId, start, end),
    ]);
    const attendanceByStaff = new Map(attendanceRows.map(row => [Number(row.staff_id), row]));
    const rows = staff.map(person => {
      const saved = attendanceByStaff.get(Number(person.id));
      return {
        ...person,
        attendance_id: saved?.id || null,
        status: saved?.status || (isWeeklyOff(person, date) ? 'Weekly Off' : ''),
        check_in: saved?.check_in ? String(saved.check_in).slice(0, 5) : '',
        check_out: saved?.check_out ? String(saved.check_out).slice(0, 5) : '',
        notes: saved?.notes || '',
        auto_weekly_off: !saved && isWeeklyOff(person, date),
      };
    });
    res.render('attendance.html', { rows, monthly, date, start, end, weekdays:WEEKDAYS, statuses:STATUSES });
  }));

  app.post('/attendance', auth, attendanceAuth, asyncRoute(async(req,res) => {
    const salonId = req.user.salon_id;
    const date = String(req.body.attendance_date || isoDate()).slice(0, 10);
    const ids = Array.isArray(req.body.staff_id) ? req.body.staff_id : req.body.staff_id ? [req.body.staff_id] : [];
    const active = await db.rows("SELECT id FROM staff WHERE salon_id=:salonId AND archived=0 AND status='Active'", { salonId });
    const allowed = new Set(active.map(row => Number(row.id)));
    let saved = 0;
    await db.transaction(async connection => {
      for (const rawId of ids) {
        const staffId = Number(rawId);
        if (!allowed.has(staffId)) continue;
        const status = String(req.body[`status_${staffId}`] || '').trim();
        if (!status) {
          await connection.execute('DELETE FROM staff_attendance WHERE salon_id=? AND staff_id=? AND attendance_date=?', [salonId, staffId, date]);
          continue;
        }
        if (!STATUSES.includes(status)) continue;
        await connection.execute(`INSERT INTO staff_attendance
          (salon_id,staff_id,attendance_date,status,check_in,check_out,notes,marked_by)
          VALUES (?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE status=VALUES(status),check_in=VALUES(check_in),check_out=VALUES(check_out),notes=VALUES(notes),marked_by=VALUES(marked_by)`,
          [salonId, staffId, date, status, cleanTime(req.body[`check_in_${staffId}`]), cleanTime(req.body[`check_out_${staffId}`]), String(req.body[`notes_${staffId}`] || '').trim() || null, req.user.id]);
        saved++;
      }
    });
    await audit(req.user.id, 'attendance.saved', 'attendance', null, `Saved ${saved} staff attendance row${saved===1?'':'s'} for ${date}`, req);
    req.flash('success', `Attendance saved for ${date}.`);
    res.redirect(`/attendance?date=${encodeURIComponent(date)}&start=${encodeURIComponent(req.body.start || '')}&end=${encodeURIComponent(req.body.end || '')}`);
  }));

  app.get('/api/payroll/attendance', auth, attendanceAuth, asyncRoute(async(req,res) => {
    const { start, end } = monthRange(req.query);
    const summaries = await summariesForPeriod(req.user.salon_id, start, end);
    res.json({ start, end, summaries });
  }));
};
