'use strict';
const crypto = require('node:crypto');
const db = require('../db');
const { asyncRoute, isoDate, toMinutes } = require('../helpers');
const { sendBookingNotifications } = require('../notifications');
const { auth } = require('./shared');

async function nextAppointmentId(salonId) {
  const last=await db.one('SELECT appointment_id FROM appointments WHERE salon_id=:salonId ORDER BY id DESC LIMIT 1',{salonId});
  const number = last ? Number(String(last.appointment_id).split('-')[1]) + 1 : 1001;
  return `APT-${number}`;
}

function asIdList(raw) {
  return (Array.isArray(raw) ? raw : [raw]).map(Number).filter(Number.isInteger);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}
async function settingsFor(salonId) {
  const rows=await db.rows('SELECT `key`,`value` FROM settings WHERE salon_id=:salonId',{salonId});
  const settings=Object.fromEntries(rows.map(row=>[row.key,row.value])),salon=await db.one('SELECT slug FROM salons WHERE id=:salonId',{salonId});settings.salon_slug=salon?.slug||'';settings.get=(key,fallback='')=>settings[key]??fallback;return settings;
}

async function loadCapacityPools(salonId) {
  const pools=await db.rows('SELECT * FROM capacity_pools WHERE salon_id=:salonId',{salonId});
  const defaultPool = pools.find(pool => pool.is_default) || pools[0] || { id: null, seats: 1 };
  return { seatsById: Object.fromEntries(pools.map(pool => [pool.id, pool.seats])), defaultPoolId: defaultPool.id, defaultSeats: defaultPool.seats };
}

async function loadOrderedServices(salonId,serviceIds) {
  if (!serviceIds.length) return [];
  const placeholders = serviceIds.map(() => '?').join(',');
  const rows=await db.rows(`SELECT * FROM services WHERE salon_id=? AND id IN (${placeholders})`,[salonId,...serviceIds]);
  const byId = new Map(rows.map(row => [row.id, row]));
  return serviceIds.map(id => byId.get(id)).filter(Boolean);
}

async function loadDayBookings(salonId,date) {
  return db.rows(
    `SELECT a.appointment_time,a.duration_mins,a.staff_id,s.capacity_pool_id
     FROM appointments a LEFT JOIN services s ON s.id=a.service_id
     WHERE a.salon_id=:salonId AND a.appointment_date=:date AND a.status NOT IN ('cancelled','no_show')`,
    {salonId,date},
  );
}

async function getSlots(salonId,date,serviceIds,staffId) {
  const services=await loadOrderedServices(salonId,serviceIds);
  if (!services.length) return [];
  const settingsRows=await db.rows('SELECT `key`,`value` FROM settings WHERE salon_id=:salonId',{salonId});
  const settings = Object.fromEntries(settingsRows.map(row => [row.key, row.value]));
  const open = toMinutes(settings.business_open || '09:00'), close = toMinutes(settings.business_close || '20:00'), interval = Number(settings.slot_interval || 30);
  const {seatsById,defaultPoolId,defaultSeats}=await loadCapacityPools(salonId);
  const poolIdFor = service => service.capacity_pool_id ?? defaultPoolId;
  const seatsFor = poolId => seatsById[poolId] ?? defaultSeats;
  const bookings=await loadDayBookings(salonId,date);
  const bookingWindow = booking => {
    const start = toMinutes(String(booking.appointment_time).slice(0, 5));
    return [start, start + Number(booking.duration_mins || 60)];
  };
  const totalDuration = services.reduce((sum, service) => sum + Number(service.duration || 60), 0);
  let minimum = null; if (date === isoDate()) { const now = new Date(); minimum = now.getHours() * 60 + now.getMinutes() + 30; }
  const slots = [];
  for (let start = open; start + totalDuration <= close; start += interval) {
    if (minimum && start < minimum) continue;
    if (staffId && bookings.some(booking => {
      if (booking.staff_id !== staffId) return false;
      const [busyStart, busyEnd] = bookingWindow(booking);
      return overlaps(start, start + totalDuration, busyStart, busyEnd);
    })) continue;
    let offset = 0, fits = true;
    for (const service of services) {
      const duration = Number(service.duration || 60);
      const segStart = start + offset, segEnd = segStart + duration;
      const poolId = poolIdFor(service), seats = seatsFor(poolId);
      const overlapCount = bookings.filter(booking => {
        if ((booking.capacity_pool_id ?? defaultPoolId) !== poolId) return false;
        const [busyStart, busyEnd] = bookingWindow(booking);
        return overlaps(segStart, segEnd, busyStart, busyEnd);
      }).length;
      if (overlapCount >= seats) { fits = false; break; }
      offset += duration;
    }
    if (fits) slots.push(`${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`);
  }
  return slots;
}

async function insertAppointmentGroup(salonId,body,status,source) {
  const serviceIds = asIdList(body.service_id);
  if (!serviceIds.length) throw new Error('Select at least one service');
  const services=await loadOrderedServices(salonId,serviceIds);
  if (!services.length) throw new Error('Selected service was not found');
  const staffId = body.staff_id ? Number(body.staff_id) : null;
  const staff=staffId?await db.one('SELECT * FROM staff WHERE id=:staffId AND salon_id=:salonId',{staffId,salonId}):null;
  if(staffId&&!staff)throw new Error('Selected team member was not found');
  if (staffId) {
    const restricted=await db.one(`SELECT COUNT(DISTINCT service_id) count FROM service_staff WHERE salon_id=? AND service_id IN (${serviceIds.map(()=>'?').join(',')})`,[salonId,...serviceIds]);
    const matched=await db.one(`SELECT COUNT(DISTINCT service_id) count FROM service_staff WHERE salon_id=? AND staff_id=? AND service_id IN (${serviceIds.map(()=>'?').join(',')})`,[salonId,staffId,...serviceIds]);
    if (Number(matched.count) !== Number(restricted.count)) throw new Error('Selected team member is not assigned to all selected services');
  }
  const groupToken = services.length > 1 ? crypto.randomBytes(9).toString('base64url') : null;
  const startMinutes = toMinutes(body.appointment_time);
  const created = [];
  let offset = 0;
  for (const service of services) {
    const duration = Number(service.duration || 60);
    const segStart = startMinutes + offset;
    const appointment = {
      salon_id:salonId,appointment_id:await nextAppointmentId(salonId),booking_token:crypto.randomBytes(18).toString('base64url'),group_token:groupToken,
      customer_id: body.customer_id ? Number(body.customer_id) : null, customer_name: String(body.customer_name || '').trim(),
      customer_mobile: String(body.customer_mobile || '').trim(), customer_email: String(body.customer_email || '').trim(),
      service_id: service.id, service_name: service.name, staff_id: staffId, staff_name: staff?.name || (source === 'online' ? 'Any Available' : ''),
      appointment_date: body.appointment_date, appointment_time: `${String(Math.floor(segStart / 60)).padStart(2, '0')}:${String(segStart % 60).padStart(2, '0')}`,
      duration_mins: duration, status, source, notes: body.notes || '', amount: Number(service.price || 0),
      notify_email: source === 'online' ? 1 : (body.notify_email ? 1 : 0), notify_whatsapp: body.notify_whatsapp ? 1 : 0,
    };
    if (source === 'online') {
      const existing=await db.one('SELECT id FROM customers WHERE salon_id=:salonId AND mobile=:mobile AND archived=0',{salonId,mobile:appointment.customer_mobile});
      if (existing) appointment.customer_id = existing.id;
    }
    await db.rows(`INSERT INTO appointments(salon_id,appointment_id,booking_token,group_token,customer_id,customer_name,customer_mobile,customer_email,
      service_id,service_name,staff_id,staff_name,appointment_date,appointment_time,duration_mins,status,source,notes,amount,notify_email,notify_whatsapp)
      VALUES(:salon_id,:appointment_id,:booking_token,:group_token,:customer_id,:customer_name,:customer_mobile,:customer_email,:service_id,:service_name,
      :staff_id,:staff_name,:appointment_date,:appointment_time,:duration_mins,:status,:source,:notes,:amount,:notify_email,:notify_whatsapp)`, appointment);
    created.push(appointment);
    offset += duration;
  }
  return created;
}

module.exports=app=>{
  app.get('/appointments',auth,asyncRoute(async(req,res)=>{
    const salonId=req.user.salon_id;
    const status_f=req.query.status||'',date_from=req.query.date_from||'',date_to=req.query.date_to||'',q=req.query.q||'';
    let sql='SELECT * FROM appointments WHERE salon_id=:salonId';const params={salonId};
    if(req.user?.role==='team'){sql+=' AND staff_id=:scopeStaffId';params.scopeStaffId=Number(req.user.staff_id||0);}
    if(status_f){sql+=' AND status=:status';params.status=status_f;}
    if(date_from&&date_to){sql+=' AND appointment_date BETWEEN :date_from AND :date_to';params.date_from=date_from;params.date_to=date_to;}
    else if(date_from){sql+=' AND appointment_date>=:date_from';params.date_from=date_from;}
    else if(date_to){sql+=' AND appointment_date<=:date_to';params.date_to=date_to;}
    if(q){sql+=' AND (customer_name LIKE :q OR customer_mobile LIKE :q OR appointment_id LIKE :q)';params.q=`%${q}%`;}
    sql+=' ORDER BY appointment_date DESC,appointment_time DESC';
    const todaySql="SELECT * FROM appointments WHERE salon_id=:salonId AND appointment_date=:today AND status NOT IN ('cancelled','no_show')"+(req.user?.role==='team'?' AND staff_id=:scopeStaffId':'')+' ORDER BY appointment_time';
    const[rows,today_list]=await Promise.all([db.rows(sql,params),db.rows(todaySql,{salonId,today:isoDate(),scopeStaffId:Number(req.user?.staff_id||0)})]);
    res.render('appointments.html',{rows,today_list,status_f,date_from,date_to,q,today:isoDate()});
  }));
  app.get('/appointments/new',auth,asyncRoute(async(req,res)=>{const salonId=req.user.salon_id,[services,staff,customers]=await Promise.all([db.rows("SELECT s.*,GROUP_CONCAT(ss.staff_id ORDER BY ss.staff_id) staff_ids FROM services s LEFT JOIN service_staff ss ON ss.service_id=s.id AND ss.salon_id=s.salon_id WHERE s.salon_id=:salonId AND s.archived=0 AND s.status='Active' GROUP BY s.id ORDER BY s.name",{salonId}),db.rows("SELECT * FROM staff WHERE salon_id=:salonId AND archived=0 AND status='Active' ORDER BY name",{salonId}),db.rows('SELECT id,customer_id,name,mobile,email FROM customers WHERE salon_id=:salonId AND archived=0 ORDER BY name',{salonId})]);res.render('appointment_form.html',{services,staff,customers});}));
  app.post('/appointments/new',auth,asyncRoute(async(req,res)=>{
    const appointments=await insertAppointmentGroup(req.user.salon_id,req.body,'confirmed','walkin');
    for(const appointment of appointments){
      if(appointment.notify_email||appointment.notify_whatsapp){const results=await sendBookingNotifications(req.settings,appointment,'confirmation');const failures=results.filter(r=>!r.ok).map(r=>`${r.channel}: ${r.message}`);if(failures.length)req.flash('error',`${appointment.appointment_id}: notification failed - ${failures.join('; ')}`);}
    }
    req.flash('success',`Appointment${appointments.length===1?'':'s'} ${appointments.map(a=>a.appointment_id).join(', ')} created.`);
    res.redirect('/appointments');
  }));
  app.get('/appointments/:aid',auth,asyncRoute(async(req,res)=>{const salonId=req.user.salon_id,appt=await db.one('SELECT * FROM appointments WHERE id=:aid AND salon_id=:salonId',{aid:Number(req.params.aid),salonId});if(!appt)return res.status(404).send('Appointment not found');if(req.user?.role==='team'&&Number(appt.staff_id)!==Number(req.user.staff_id||0))return res.status(403).render('access_denied.html');const group=appt.group_token?await db.rows('SELECT * FROM appointments WHERE salon_id=:salonId AND group_token=:token AND id!=:aid ORDER BY appointment_time',{salonId,token:appt.group_token,aid:appt.id}):[];res.render('appointment_detail.html',{appt,group,cfg:req.settings});}));
  app.post('/appointments/:aid/status',auth,asyncRoute(async(req,res)=>{const status=req.body.status;if(!['pending','confirmed','completed','cancelled','no_show'].includes(status))return res.status(400).send('Invalid status');const aid=Number(req.params.aid),salonId=req.user.salon_id;await db.rows('UPDATE appointments SET status=:status,cancel_reason=:reason WHERE id=:aid AND salon_id=:salonId',{status,reason:req.body.cancel_reason||'',aid,salonId});const appointment=await db.one('SELECT * FROM appointments WHERE id=:aid AND salon_id=:salonId',{aid,salonId});if(!appointment)return res.status(404).send('Appointment not found');if(['confirmed','cancelled'].includes(status)){const type=status==='confirmed'?'confirmation':'cancellation',results=await sendBookingNotifications(req.settings,appointment,type),failures=results.filter(r=>!r.ok).map(r=>`${r.channel}: ${r.message}`);if(failures.length)req.flash('error',`Status saved, but notification failed: ${failures.join('; ')}`);}req.flash('success',`Appointment marked as ${status.replaceAll('_',' ')}.`);res.redirect(`/appointments/${aid}`);}));
  app.post('/appointments/:aid/send-reminder',auth,asyncRoute(async(req,res)=>{const aid=Number(req.params.aid),salonId=req.user.salon_id,appointment=await db.one('SELECT * FROM appointments WHERE id=:aid AND salon_id=:salonId',{aid,salonId});if(!appointment)return res.status(404).send('Appointment not found');const results=await sendBookingNotifications(req.settings,appointment,'reminder'),ok=results.filter(r=>r.ok).length;if(ok)await db.rows('UPDATE appointments SET reminder_sent=1 WHERE id=:aid AND salon_id=:salonId',{aid,salonId});const failures=results.filter(r=>!r.ok).map(r=>`${r.channel}: ${r.message}`).join('; ');req.flash(ok?'success':'error',`Reminder sent (${ok}/${results.length} channels OK).${failures?` ${failures}`:''}`);res.redirect(`/appointments/${aid}`);}));

  app.get('/book',asyncRoute(async(req,res)=>{if(!req.salon)return res.status(400).send('Use a salon booking link.');const salonId=req.salon.id,[services,staff]=await Promise.all([db.rows("SELECT * FROM services WHERE salon_id=:salonId AND archived=0 AND status='Active' ORDER BY popular DESC,name",{salonId}),db.rows("SELECT * FROM staff WHERE salon_id=:salonId AND archived=0 AND status='Active' ORDER BY name",{salonId})]);res.render('book.html',{services,staff,cfg:res.locals.cfg});}));
  app.post('/book',asyncRoute(async(req,res)=>{if(!req.salon)return res.status(400).send('Use a salon booking link.');const appointments=await insertAppointmentGroup(req.salon.id,req.body,'pending','online');res.redirect(`/book/success/${appointments.map(a=>a.booking_token).join('+')}?salon=${encodeURIComponent(req.salon.slug)}`);}));
  app.get('/book/success/:tokens',asyncRoute(async(req,res)=>{if(!req.salon)return res.status(400).send('Use a salon booking link.');const tokens=req.params.tokens.split('+'),placeholders=tokens.map(()=>'?').join(','),appts=await db.rows(`SELECT * FROM appointments WHERE salon_id=? AND booking_token IN (${placeholders}) ORDER BY appointment_time`,[req.salon.id,...tokens]);if(!appts.length)return res.status(404).send('Booking not found');res.render('book_success.html',{appts,total:appts.reduce((sum,a)=>sum+Number(a.amount||0),0),cfg:req.settings});}));
  app.get('/book/cancel/:token',asyncRoute(async(req,res)=>{const appt=await db.platformOne('SELECT * FROM appointments WHERE booking_token=:token',{token:req.params.token});if(!appt||(req.salon&&Number(req.salon.id)!==Number(appt.salon_id)))return res.status(404).send('Booking not found');const settings=await settingsFor(appt.salon_id);res.render('book_cancel.html',{appt,cfg:settings,already_done:['cancelled','completed','no_show'].includes(appt.status)});}));
  app.post('/book/cancel/:token',asyncRoute(async(req,res)=>{const appt=await db.platformOne('SELECT * FROM appointments WHERE booking_token=:token',{token:req.params.token});if(!appt||(req.salon&&Number(req.salon.id)!==Number(appt.salon_id)))return res.status(404).send('Booking not found');const settings=await settingsFor(appt.salon_id);if(!['cancelled','completed','no_show'].includes(appt.status)){await db.rows("UPDATE appointments SET status='cancelled',cancel_reason='Cancelled by customer' WHERE booking_token=:token AND salon_id=:salonId",{token:req.params.token,salonId:appt.salon_id});await sendBookingNotifications(settings,appt,'cancellation');}res.redirect(`/book/cancel/${req.params.token}`);}));
  app.get('/api/slots',asyncRoute(async(req,res)=>{if(!req.salon)return res.status(400).json([]);const date=req.query.date,serviceIds=asIdList(req.query.service_id),staffId=req.query.staff_id?Number(req.query.staff_id):null;if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!serviceIds.length)return res.json([]);res.json(await getSlots(req.salon.id,date,serviceIds,staffId));}));
  app.post('/tasks/send-reminders',asyncRoute(async(req,res)=>{
    const supplied=req.get('x-cron-secret')||req.query.key;
    if(!process.env.CRON_SECRET||supplied!==process.env.CRON_SECRET)return res.status(403).json({error:'Forbidden'});
    const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);
    const appointments=await db.platformRows("SELECT * FROM appointments WHERE appointment_date=:date AND status IN ('pending','confirmed') AND reminder_sent=0",{date:isoDate(tomorrow)});
    let sent=0,failed=0;
    for(const appointment of appointments){const settings=await settingsFor(appointment.salon_id),results=await sendBookingNotifications(settings,appointment,'reminder');if(results.some(result=>result.ok)){await db.rows('UPDATE appointments SET reminder_sent=1 WHERE id=:id AND salon_id=:salonId',{id:appointment.id,salonId:appointment.salon_id});sent++;}else failed++;}
    res.json({ok:true,total:appointments.length,sent,failed});
  }));
  app.get('/health',asyncRoute(async(_req,res)=>{await db.one('SELECT 1 ok');res.json({ok:true});}));
};
