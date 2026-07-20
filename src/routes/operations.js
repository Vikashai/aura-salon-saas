'use strict';
const db = require('../db');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { Readable } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { asyncRoute, isoDate, firstName } = require('../helpers');
const { sendWhatsApp, sendEmail } = require('../notifications');
const { auth, loyaltyConfig, awardPoints } = require('./shared');
const { summariesForPeriod } = require('../attendance-service');
const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:5*1024*1024 } });

const MODULES = {
  services: ['services','Services','Service',['name','category','price','duration','commission','capacity_pool_id','status'],['Service name','Category','Price','Duration (min)','Commission %','Capacity pool','Status']],
  staff: ['staff','Team','Team member',['name','mobile','role','joining_date','fixed_salary','weekly_off_day','status'],['Full name','Mobile','Role','Joining date','Fixed salary','Weekly off','Status']],
  inventory: ['products','Inventory','Product',['name','category','brand','sku','selling_price','stock','low_stock','unit','status'],['Product name','Category','Brand','SKU','Selling price','Stock','Low stock level','Unit','Status']],
  packages: ['packages','Packages & memberships','Plan',['name','kind','price','validity','sessions','status'],['Plan name','Type','Price','Validity (days)','Sessions','Status']],
  expenses: ['expenses','Expenses','Expense',['expense_date','category','subcategory','employee_name','amount','payment_mode','paid_to','reference_no','period_start','period_end','due_date','notes'],['Date','Category','Type / purpose','Employee','Amount','Payment mode','Paid to','Reference','Period from','Period to','Due date','Notes']],
};
const SETTINGS_KEYS = ['salon_name','invoice_prefix','gst_number','tax_enabled','address','contact','email',
  'salon_phone','salon_email','business_open','business_close','slot_interval','smtp_host','smtp_port','smtp_user',
  'smtp_pass','smtp_from','billing_auto_email','whatsapp_provider','meta_whatsapp_token','meta_phone_number_id','meta_api_version',
  'meta_template_language','meta_template_confirmation','meta_template_reminder','meta_template_cancellation',
  'meta_template_invoice','billing_auto_whatsapp','meta_template_welcome','meta_template_birthday','meta_template_anniversary','twilio_sid','twilio_token',
  'twilio_whatsapp_from','base_url','loyalty_enabled','loyalty_earn_rate','loyalty_redeem_rate',
  'loyalty_min_redeem','loyalty_max_redeem_pct','loyalty_expiry_months','loyalty_referral_referrer',
  'loyalty_referral_referee','referral_referrer_credit','referral_referee_discount','loyalty_earn_on_services','loyalty_earn_on_products','msg_welcome','msg_birthday','msg_anniversary'];

function values(body, key) { const value = body[key]; return Array.isArray(value) ? value : value == null ? [] : [value]; }
function adjustmentRows(body, staffId) {
  const types=values(body,`payroll_adjust_type_${staffId}`),amounts=values(body,`payroll_adjust_amount_${staffId}`),reasons=values(body,`payroll_adjust_reason_${staffId}`);
  return amounts.map((rawAmount,index)=>({type:types[index]==='deduct'?'deduct':'add',amount:Math.round(Number(rawAmount||0)*100)/100,reason:String(reasons[index]||'').trim()})).filter(row=>row.amount>0||row.reason);
}
function describePayrollNotes(baseNotes, summary, adjustments) {
  const lines=[String(baseNotes||'').trim()].filter(Boolean);
  if(summary)lines.push(`Attendance: ${summary.present} present, ${summary.half_day} half day, ${summary.absent} absent, ${summary.leave} leave, ${summary.weekly_off} weekly off, ${summary.not_marked} not marked.`);
  for(const item of adjustments)lines.push(`${item.type==='deduct'?'Deduction':'Addition'}: ${item.amount} - ${item.reason}`);
  return lines.join('\n');
}
function csvValue(value) { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replaceAll('"','""')}"` : text; }
function settingObject(rows) { const data = Object.fromEntries(rows.map(row => [row.key, row.value])); data.get = (key, fallback='') => data[key] ?? fallback; return data; }
function serviceCategory(gender, category) {
  const cleanGender = ['Women','Men','Both'].includes(String(gender || '').trim()) ? String(gender).trim() : 'Both';
  const cleanCategory = String(category || '').trim().replace(/^((Women|Men|Both)(?:\s+·\s+|\s+-\s+))/i, '');
  return cleanCategory ? `${cleanGender} · ${cleanCategory}` : '';
}
function categoryName(value) { return String(value || '').replace(/^(Women|Men|Both)(?:\s+·\s+|\s+-\s+)/, ''); }
function categoryGender(value) { return (String(value || '').match(/^(Women|Men|Both)(?=\s+(?:·|-))/) || [])[1] || 'Both'; }
function categoryOptions(categoryValues) {
  const byName = new Map();
  for (const value of categoryValues) {
    const name = categoryName(value); if (!name) continue;
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(categoryGender(value));
  }
  return [...byName].map(([name, genders]) => ({ name, genders:[...genders].join(',') })).sort((a,b)=>a.name.localeCompare(b.name));
}
async function saveServiceStaff(salonId,serviceId,staffIds) {
  const ids = [...new Set(staffIds.map(Number).filter(Number.isInteger))];
  await db.transaction(async connection => {
    await connection.execute('DELETE FROM service_staff WHERE salon_id=? AND service_id=?',[salonId,serviceId]);
    for(const staffId of ids)await connection.execute('INSERT IGNORE INTO service_staff(salon_id,service_id,staff_id) SELECT ?,?,id FROM staff WHERE id=? AND salon_id=?',[salonId,serviceId,staffId,salonId]);
  });
}
async function saveStaffServices(salonId,staffId,serviceIds) {
  const ids = [...new Set(serviceIds.map(Number).filter(Number.isInteger))];
  await db.transaction(async connection => {
    await connection.execute('DELETE FROM service_staff WHERE salon_id=? AND staff_id=?',[salonId,staffId]);
    for(const serviceId of ids)await connection.execute('INSERT IGNORE INTO service_staff(salon_id,service_id,staff_id) SELECT ?,id,? FROM services WHERE id=? AND salon_id=?',[salonId,staffId,serviceId,salonId]);
  });
}

module.exports = app => {
  app.get('/manage/:module', auth, asyncRoute(async (req, res) => {
    const salonId=req.user.salon_id;
    const definition = MODULES[req.params.module];
    if (!definition) return res.status(404).send('Not found');
    const [table,title,singular,fields,labels] = definition;
    const archived=['services','staff','products','packages'].includes(table)?' AND archived=0':'';
    const isServices = table === 'services';
    const rows = await db.rows(isServices
      ? `SELECT services.*,capacity_pools.name capacity_pool_name FROM services LEFT JOIN capacity_pools ON capacity_pools.id=services.capacity_pool_id AND capacity_pools.salon_id=services.salon_id WHERE services.salon_id=?${archived} ORDER BY services.id DESC`
      : `SELECT * FROM ${table} WHERE salon_id=?${archived} ORDER BY id DESC`,[salonId]);
    const categories = [...new Set(rows.map(row=>row.category).filter(Boolean))].sort();
    const capacity_pools=isServices?await db.rows('SELECT * FROM capacity_pools WHERE salon_id=:salonId ORDER BY is_default DESC,name',{salonId}):[];
    const staff_options=(isServices||table==='expenses')?await db.rows("SELECT id,name,role,fixed_salary FROM staff WHERE salon_id=:salonId AND archived=0 AND status='Active' ORDER BY name",{salonId}):[];
    const service_options=table==='staff'?await db.rows("SELECT id,name,category FROM services WHERE salon_id=:salonId AND archived=0 AND status='Active' ORDER BY category,name",{salonId}):[];
    const service_category_options = categoryOptions(categories);
    res.render('manage.html', { module:req.params.module,title,singular,fields,labels,rows,categories,capacity_pools,staff_options,service_options,service_category_options });
  }));
  app.post('/manage/:module', auth, asyncRoute(async (req, res) => {
    const salonId=req.user.salon_id;
    const definition = MODULES[req.params.module];
    if (!definition) return res.status(404).send('Not found');
    const [table,,singular,fields] = definition;
    if (table === 'services') req.body.category = serviceCategory(req.body.gender, req.body.category_name==='__new__'?req.body.custom_category_name:req.body.category_name);
    if(table==='services'&&req.body.capacity_pool_id&&!await db.one('SELECT id FROM capacity_pools WHERE id=:id AND salon_id=:salonId',{id:Number(req.body.capacity_pool_id),salonId}))req.body.capacity_pool_id=null;
    if (table === 'expenses') {
      const category=String(req.body.category||'').trim(),expenseDate=req.body.expense_date||isoDate(),paymentMode=String(req.body.payment_mode||'').trim(),periodStart=req.body.period_start||null,periodEnd=req.body.period_end||null,dueDate=req.body.due_date||null,referenceNo=String(req.body.reference_no||'').trim()||null,notes=String(req.body.notes||'').trim()||null;
      if (category === 'Payroll') {
        const staffIds=values(req.body,'payroll_staff_ids').map(Number).filter(Number.isInteger);
        if(!staffIds.length){req.flash('error','Select at least one employee for payroll.');return res.redirect('/manage/expenses');}
        const summaries=new Map((await summariesForPeriod(salonId,periodStart||expenseDate,periodEnd||expenseDate,staffIds)).map(row=>[Number(row.id),row]));
        const group=`PAY-${Date.now().toString(36).toUpperCase()}`;let created=0;
        for(const staffId of staffIds){
          const person=await db.one('SELECT id,name,fixed_salary FROM staff WHERE id=:id AND salon_id=:salonId AND archived=0',{id:staffId,salonId}),amount=Math.round(Number(req.body[`payroll_amount_${staffId}`]||0)*100)/100;
          if(!person||amount<=0)continue;
          const adjustments=adjustmentRows(req.body,staffId),badAdjustment=adjustments.find(item=>item.amount<=0||!item.reason);
          if(badAdjustment){req.flash('error','Every payroll addition or deduction needs an amount and reason.');return res.redirect('/manage/expenses');}
          const summary=summaries.get(staffId),baseAmount=Number(req.body[`payroll_base_${staffId}`]||person.fixed_salary||0),attendanceAmount=summary?.suggested_amount||null,payrollNotes=describePayrollNotes(notes,summary,adjustments);
          await db.rows('INSERT INTO expenses(salon_id,expense_date,category,subcategory,employee_name,expense_group,amount,payment_mode,paid_to,reference_no,period_start,period_end,due_date,notes,payroll_staff_id,payroll_base_amount,payroll_attendance_amount,payroll_adjustments,payroll_attendance_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[salonId,expenseDate,'Payroll','Salary',person.name,group,amount,paymentMode,person.name,referenceNo,periodStart,periodEnd,dueDate,payrollNotes,staffId,baseAmount,attendanceAmount,JSON.stringify(adjustments),JSON.stringify(summary||{})]);created++;
        }
        if(!created){req.flash('error','Enter a payroll amount for each selected employee.');return res.redirect('/manage/expenses');}
        req.flash('success',`Payroll recorded for ${created} employee${created===1?'':'s'}.`);return res.redirect('/manage/expenses');
      }
      const amount=Number(req.body.amount||0);if(!category||amount<=0){req.flash('error','Choose a category and enter a valid expense amount.');return res.redirect('/manage/expenses');}
      await db.rows('INSERT INTO expenses(salon_id,expense_date,category,subcategory,employee_name,expense_group,amount,payment_mode,paid_to,reference_no,period_start,period_end,due_date,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[salonId,expenseDate,category,String(req.body.subcategory||'').trim()||null,String(req.body.employee_name||'').trim()||null,null,amount,paymentMode,String(req.body.paid_to||'').trim()||null,referenceNo,periodStart,periodEnd,dueDate,notes]);
      req.flash('success','Expense added successfully.');return res.redirect('/manage/expenses');
    }
    const placeholders = fields.map(() => '?').join(',');
    const result=await db.rows(`INSERT INTO ${table} (salon_id,${fields.map(field=>`\`${field}\``).join(',')}) VALUES (?,${placeholders})`,[salonId,...fields.map(field=>req.body[field]||null)]);
    if(table==='services')await saveServiceStaff(salonId,result.insertId,values(req.body,'staff_ids'));
    if(table==='staff')await saveStaffServices(salonId,result.insertId,values(req.body,'service_ids'));
    req.flash('success', `${singular} added successfully.`); res.redirect(`/manage/${req.params.module}`);
  }));
  app.get('/manage/:module/import-template', auth, asyncRoute(async(req,res) => {
    const definition=MODULES[req.params.module];if(!definition)return res.status(404).send('Not found');
    const fields=definition[3],book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Import');sheet.addRow(fields);sheet.getRow(1).font={bold:true};sheet.columns=fields.map(field=>({header:field,key:field,width:22}));
    const buffer=await book.xlsx.writeBuffer();res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(`${req.params.module}-import-template.xlsx`).send(Buffer.from(buffer));
  }));
  app.post('/manage/:module/import', auth, upload.single('spreadsheet'), asyncRoute(async(req,res)=>{
    const salonId=req.user.salon_id;
    const definition=MODULES[req.params.module];if(!definition)return res.status(404).send('Not found');
    if(!req.file){req.flash('error','Choose an Excel or CSV file.');return res.redirect(`/manage/${req.params.module}`);}
    const [table,,singular,fields]=definition,book=new ExcelJS.Workbook(),isCsv=req.file.originalname.toLowerCase().endsWith('.csv');
    if(isCsv)await book.csv.read(Readable.from(req.file.buffer.toString('utf8')));else await book.xlsx.load(req.file.buffer);
    const sheet=book.worksheets[0];if(!sheet){req.flash('error','The spreadsheet has no worksheet.');return res.redirect(`/manage/${req.params.module}`);}
    const cellText=value=>value==null?'':typeof value==='object'?(value.text||value.result||''):value;
    const headers=sheet.getRow(1).values.slice(1).map(cellText),records=[];for(let rowNumber=2;rowNumber<=sheet.rowCount;rowNumber++){const row=sheet.getRow(rowNumber);records.push(Object.fromEntries(headers.map((header,index)=>[header,cellText(row.getCell(index+1).value)])));}
    const normalize=value=>String(value||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
    let imported=0,skipped=0;
    for(const raw of records){const source=Object.fromEntries(Object.entries(raw).map(([key,value])=>[normalize(key),value]));const values=fields.map(field=>source[field]??'');if(!values[0]){skipped++;continue;}
      await db.rows(`INSERT INTO ${table} (salon_id,${fields.map(field=>`\`${field}\``).join(',')}) VALUES (?,${fields.map(()=>'?').join(',')})`,[salonId,...values.map(value=>value===''?null:value)]);imported++;}
    req.flash('success',`${imported} ${singular.toLowerCase()} record${imported===1?'':'s'} imported.${skipped?` ${skipped} blank rows skipped.`:''}`);res.redirect(`/manage/${req.params.module}`);
  }));
  app.post('/manage/:module/bulk', auth, asyncRoute(async(req,res)=>{
    const salonId=req.user.salon_id;
    const definition=MODULES[req.params.module];if(!definition)return res.status(404).send('Not found');
    const [table]=definition,ids=values(req.body,'ids').map(Number).filter(Number.isInteger),action=req.body.bulk_action;
    if(!ids.length){req.flash('error','Select at least one record.');return res.redirect(`/manage/${req.params.module}`);}
    const placeholders=ids.map(()=>'?').join(',');
    if(action==='active'&&['services','staff','products','packages'].includes(table))await db.rows(`UPDATE ${table} SET status='Active' WHERE salon_id=? AND id IN (${placeholders})`,[salonId,...ids]);
    else if(action==='inactive'&&['services','staff','products','packages'].includes(table))await db.rows(`UPDATE ${table} SET status='Inactive' WHERE salon_id=? AND id IN (${placeholders})`,[salonId,...ids]);
    else if(action==='archive'&&['services','staff','products','packages'].includes(table))await db.rows(`UPDATE ${table} SET archived=1 WHERE salon_id=? AND id IN (${placeholders})`,[salonId,...ids]);
    else{req.flash('error','Choose a valid bulk action.');return res.redirect(`/manage/${req.params.module}`);}
    req.flash('success',`${ids.length} record${ids.length===1?'':'s'} updated.`);res.redirect(`/manage/${req.params.module}`);
  }));
  app.get('/manage/:module/:id/edit', auth, asyncRoute(async(req,res)=>{
    const salonId=req.user.salon_id,definition=MODULES[req.params.module];if(!definition)return res.status(404).send('Not found');const [table,title,singular,fields,labels]=definition,row=await db.one(`SELECT * FROM ${table} WHERE id=:id AND salon_id=:salonId`,{id:Number(req.params.id),salonId});if(!row)return res.status(404).send('Record not found');
    const capacity_pools=table==='services'?await db.rows('SELECT * FROM capacity_pools WHERE salon_id=:salonId ORDER BY is_default DESC,name',{salonId}):[];
    const staff_options=table==='services'?await db.rows("SELECT id,name,role FROM staff WHERE salon_id=:salonId AND archived=0 AND status='Active' ORDER BY name",{salonId}):[];
    const service_options=table==='staff'?await db.rows("SELECT id,name,category FROM services WHERE salon_id=:salonId AND archived=0 AND status='Active' ORDER BY category,name",{salonId}):[];
    const selected_staff_ids=table==='services'?(await db.rows('SELECT staff_id FROM service_staff WHERE service_id=:id AND salon_id=:salonId',{id:Number(req.params.id),salonId})).map(item=>item.staff_id):[];
    const selected_service_ids=table==='staff'?(await db.rows('SELECT service_id FROM service_staff WHERE staff_id=:id AND salon_id=:salonId',{id:Number(req.params.id),salonId})).map(item=>item.service_id):[];
    const allCategories=table==='services'?await db.rows("SELECT DISTINCT category FROM services WHERE salon_id=:salonId AND archived=0 AND category IS NOT NULL ORDER BY category",{salonId}):[];
    const service_category_options=categoryOptions(allCategories.map(item=>item.category));
    const category_parts=table==='services'?{gender:(String(row.category||'').match(/^(Women|Men|Both)(?=\s+(?:·|-))/)||[])[1]||'Both',name:categoryName(row.category)}:{gender:'Both',name:''};
    res.render('manage_edit.html',{module:req.params.module,title,singular,fields,labels,row,capacity_pools,staff_options,service_options,selected_staff_ids,selected_service_ids,service_category_options,category_parts});
  }));
  app.post('/manage/:module/:id/edit', auth, asyncRoute(async(req,res)=>{
    const salonId=req.user.salon_id,definition=MODULES[req.params.module];if(!definition)return res.status(404).send('Not found');const [table,,singular,fields]=definition,id=Number(req.params.id);if(table==='services')req.body.category=serviceCategory(req.body.gender,req.body.category_name==='__new__'?req.body.custom_category_name:req.body.category_name);if(table==='services'&&req.body.capacity_pool_id&&!await db.one('SELECT id FROM capacity_pools WHERE id=:poolId AND salon_id=:salonId',{poolId:Number(req.body.capacity_pool_id),salonId}))req.body.capacity_pool_id=null;const assignments=fields.map(field=>`\`${field}\`=?`).join(',');const result=await db.rows(`UPDATE ${table} SET ${assignments} WHERE id=? AND salon_id=?`,[...fields.map(field=>req.body[field]||null),id,salonId]);if(!result.affectedRows)return res.status(404).send('Record not found');if(table==='services')await saveServiceStaff(salonId,id,values(req.body,'staff_ids'));if(table==='staff')await saveStaffServices(salonId,id,values(req.body,'service_ids'));req.flash('success',`${singular} updated.`);res.redirect(`/manage/${req.params.module}`);
  }));

  app.get('/reports', auth, asyncRoute(async (req, res) => {
    const defaultStart = new Date(); defaultStart.setDate(defaultStart.getDate()-30);
    const salonId=req.user.salon_id,start=req.query.start||isoDate(defaultStart),end=req.query.end||isoDate();
    const [sales, expenseRow] = await Promise.all([
      db.rows('SELECT s.*,c.name customer FROM sales s LEFT JOIN customers c ON c.id=s.customer_id AND c.salon_id=s.salon_id WHERE s.salon_id=:salonId AND invoice_date BETWEEN :start AND :end AND cancelled=0 ORDER BY invoice_date DESC',{salonId,start,end}),
      db.one('SELECT COALESCE(SUM(amount),0) value FROM expenses WHERE salon_id=:salonId AND expense_date BETWEEN :start AND :end',{salonId,start,end}),
    ]);
    if (req.query.export === 'csv') {
      const lines = [['Invoice','Date','Customer','Amount','Paid','Pending','Mode','Status'], ...sales.map(row =>
        [row.invoice_no,row.invoice_date,row.customer,row.final_amount,row.paid_amount,row.pending_amount,row.payment_mode,row.payment_status])];
      res.type('text/csv').attachment('sales-report.csv').send(lines.map(line=>line.map(csvValue).join(',')).join('\n')); return;
    }
    const modeTotals=new Map();for(const sale of sales){const text=String(sale.payment_mode||''),parts=[...text.matchAll(/(?:^| \+ )(.+?) ₹([0-9.]+)/g)];if(parts.length){for(const part of parts)modeTotals.set(part[1],(modeTotals.get(part[1])||0)+Number(part[2]))}else modeTotals.set(text||'Unspecified',(modeTotals.get(text||'Unspecified')||0)+Number(sale.paid_amount||0));}const modes=[...modeTotals].map(([payment_mode,amount])=>({payment_mode,amount}));
    res.render('reports.html',{sales,start,end,revenue:sales.reduce((s,r)=>s+Number(r.final_amount),0),expenses:Number(expenseRow.value),pending:sales.reduce((s,r)=>s+Number(r.pending_amount),0),modes});
  }));

  app.get('/greetings', auth, asyncRoute(async (req,res) => {
    const salonId=req.user.salon_id,today=new Date(),monthDay=date=>(date.getMonth()+1)*100+date.getDate(),todayMd=monthDay(today);
    const upcoming=[]; for(let i=1;i<=7;i++){const d=new Date(today);d.setDate(d.getDate()+i);upcoming.push(monthDay(d));}
    const placeholders=upcoming.map(()=>'?').join(',');
    const [birthdays_today,anniversaries_today,upcoming_birthdays,upcoming_anniversaries,settingsRows]=await Promise.all([
      db.rows("SELECT * FROM customers WHERE salon_id=? AND (MONTH(dob)*100+DAY(dob))=? AND status='Active' ORDER BY name",[salonId,todayMd]),
      db.rows("SELECT * FROM customers WHERE salon_id=? AND (MONTH(anniversary)*100+DAY(anniversary))=? AND status='Active' ORDER BY name",[salonId,todayMd]),
      db.rows(`SELECT * FROM customers WHERE salon_id=? AND (MONTH(dob)*100+DAY(dob)) IN (${placeholders}) AND status='Active' ORDER BY MONTH(dob),DAY(dob)`,[salonId,...upcoming]),
      db.rows(`SELECT * FROM customers WHERE salon_id=? AND (MONTH(anniversary)*100+DAY(anniversary)) IN (${placeholders}) AND status='Active' ORDER BY MONTH(anniversary),DAY(anniversary)`,[salonId,...upcoming]),
      db.rows('SELECT `key`,`value` FROM settings WHERE salon_id=?',[salonId]),
    ]);
    res.render('greetings.html',{birthdays_today,anniversaries_today,upcoming_birthdays,upcoming_anniversaries,
      data:settingObject(settingsRows),today,today_display:new Intl.DateTimeFormat('en-US',{month:'long',day:'2-digit',year:'numeric'}).format(today),current_year:today.getFullYear()});
  }));
  app.post('/greetings/send',auth,asyncRoute(async(req,res)=>{
    const customer=await db.one('SELECT * FROM customers WHERE id=:id AND salon_id=:salonId',{id:Number(req.body.customer_id),salonId:req.user.salon_id}),type=req.body.msg_type;
    if(!customer){req.flash('error','Customer not found.');return res.redirect('/greetings');}
    const template=req.settings[`msg_${type}`]||'';
    if(!template){req.flash('error',`No template set for ${type} messages.`);return res.redirect('/greetings');}
    const first=firstName(customer.name),salon=req.settings.salon_name||'our salon';
    const result=await sendWhatsApp(req.settings,customer.mobile,template.replaceAll('{name}',first).replaceAll('{salon_name}',salon),req.settings[`meta_template_${type}`]||null,[first,salon]);
    req.flash(result.ok?'success':'error',result.ok?`Sent to ${customer.name}!`:`Failed - ${result.message}`);res.redirect('/greetings');
  }));
  app.post('/greetings/send-all',auth,asyncRoute(async(req,res)=>{
    const type=req.body.msg_type,template=req.settings[`msg_${type}`]||'',ids=values(req.body,'customer_ids');let sent=0,failed=0;
    for(const id of ids){const customer=await db.one('SELECT * FROM customers WHERE id=:id AND salon_id=:salonId',{id:Number(id),salonId:req.user.salon_id});if(customer&&template){const first=firstName(customer.name),salon=req.settings.salon_name||'our salon';const result=await sendWhatsApp(req.settings,customer.mobile,template.replaceAll('{name}',first).replaceAll('{salon_name}',salon),req.settings[`meta_template_${type}`]||null,[first,salon]);result.ok?sent++:failed++;}}
    req.flash(sent?'success':'error',`Sent ${sent} messages.${failed?` ${failed} failed - check WhatsApp settings.`:''}`);res.redirect('/greetings');
  }));
  app.post('/greetings/templates',auth,asyncRoute(async(req,res)=>{
    for(const key of ['msg_welcome','msg_birthday','msg_anniversary'])await db.rows('INSERT INTO settings (salon_id,`key`,`value`) VALUES (:salonId,:key,:value) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)',{salonId:req.user.salon_id,key,value:req.body[key]||''});
    req.flash('success','Message templates saved.');res.redirect('/greetings');
  }));

  app.get('/loyalty',auth,asyncRoute(async(req,res)=>{
    const salonId=req.user.salon_id,statQueries={pts_in_circulation:'SELECT COALESCE(SUM(loyalty_points),0) value FROM customers WHERE salon_id=:salonId',pts_awarded:'SELECT COALESCE(SUM(points),0) value FROM loyalty_transactions WHERE salon_id=:salonId AND points>0',pts_redeemed:"SELECT ABS(COALESCE(SUM(points),0)) value FROM loyalty_transactions WHERE salon_id=:salonId AND type='redeem'",total_discount:'SELECT COALESCE(SUM(loyalty_discount+referral_discount+referral_credit_used),0) value FROM sales WHERE salon_id=:salonId',total_referrals:'SELECT COUNT(*) value FROM customers WHERE salon_id=:salonId AND referred_by_id IS NOT NULL',active_members:'SELECT COUNT(*) value FROM customers WHERE salon_id=:salonId AND (loyalty_points>0 OR referral_credit>0)',total_customers:'SELECT COUNT(*) value FROM customers WHERE salon_id=:salonId'};
    const stats={};for(const[key,sql]of Object.entries(statQueries))stats[key]=Number((await db.one(sql,{salonId})).value);
    const [leaderboard,recent_txns,referral_pairs]=await Promise.all([
      db.rows('SELECT id,name,mobile,loyalty_points FROM customers WHERE salon_id=:salonId AND loyalty_points>0 ORDER BY loyalty_points DESC LIMIT 10',{salonId}),
      db.rows('SELECT lt.*,c.name customer_name,c.id cust_id FROM loyalty_transactions lt JOIN customers c ON lt.customer_id=c.id AND c.salon_id=lt.salon_id WHERE lt.salon_id=:salonId ORDER BY lt.id DESC LIMIT 50',{salonId}),
      db.rows('SELECT r.id referee_id,r.name referee_name,r.mobile referee_mobile,r.loyalty_points referee_pts,ref.name referrer_name,ref.mobile referrer_mobile,ref.referral_credit referrer_credit FROM customers r JOIN customers ref ON r.referred_by_id=ref.id AND ref.salon_id=r.salon_id WHERE r.salon_id=:salonId ORDER BY r.id DESC LIMIT 30',{salonId}),
    ]);
    res.render('loyalty.html',{cfg:loyaltyConfig(req.settings),data:req.settings,stats,leaderboard,recent_txns,referral_pairs});
  }));
  app.post('/loyalty/settings',auth,asyncRoute(async(req,res)=>{
    const keys=['loyalty_enabled','loyalty_earn_rate','loyalty_redeem_rate','loyalty_min_redeem','loyalty_max_redeem_pct','loyalty_expiry_months','referral_referrer_credit','referral_referee_discount','loyalty_earn_on_services','loyalty_earn_on_products'];
    for(const key of keys)await db.rows('INSERT INTO settings (salon_id,`key`,`value`) VALUES (:salonId,:key,:value) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)',{salonId:req.user.salon_id,key,value:req.body[key]||''});
    req.flash('success','Loyalty rules saved.');res.redirect('/loyalty');
  }));
  app.post('/customers/:cid/loyalty/adjust',auth,asyncRoute(async(req,res)=>{
    const cid=Number(req.params.cid),salonId=req.user.salon_id,points=Number.parseInt(req.body.points||0,10),customer=await db.one('SELECT loyalty_points FROM customers WHERE id=:cid AND salon_id=:salonId',{cid,salonId});
    if(!points){req.flash('error','Enter a non-zero point value.');return res.redirect(`/customers/${cid}`);}
    if(!customer||Number(customer.loyalty_points)+points<0){req.flash('error',`Cannot deduct more than current balance (${customer?.loyalty_points||0} pts).`);return res.redirect(`/customers/${cid}`);}
    await db.transaction(connection=>awardPoints(connection,salonId,cid,points,'manual',String(req.body.reason||'').trim()||'Manual adjustment'));
    req.flash('success',`${points>0?'Added':'Deducted'} ${Math.abs(points)} points.`);res.redirect(`/customers/${cid}`);
  }));
  app.get('/api/loyalty/:cid',auth,asyncRoute(async(req,res)=>{
    const customer=await db.one('SELECT loyalty_points FROM customers WHERE id=:cid AND salon_id=:salonId',{cid:Number(req.params.cid),salonId:req.user.salon_id}),cfg=loyaltyConfig(req.settings),balance=Number(customer?.loyalty_points||0),amount=Number(req.query.amount||0);
    const base={enabled:Boolean(customer)&&cfg.enabled,balance,earn_rate:cfg.earn_rate,min_redeem:cfg.min_redeem,redeem_rate:cfg.redeem_rate,max_redeem_pct:cfg.max_redeem_pct};
    if(!base.enabled||balance<cfg.min_redeem||amount<=0)return res.json({...base,redeemable_points:0,redeemable_rupees:0});
    const maxRupees=Math.min(amount*cfg.max_redeem_pct/100,balance/cfg.redeem_rate),redeemablePoints=Math.min(Math.floor(maxRupees*cfg.redeem_rate),balance);
    res.json({...base,redeemable_points:redeemablePoints,redeemable_rupees:Math.round(redeemablePoints/cfg.redeem_rate*100)/100});
  }));

  app.get('/settings',auth,asyncRoute(async(req,res)=>{const salonId=req.user.salon_id,data={...res.locals.cfg};data.meta_token_configured=Boolean(data.meta_whatsapp_token);data.twilio_token_configured=Boolean(data.twilio_token);data.smtp_pass_configured=Boolean(data.smtp_pass);data.meta_whatsapp_token='';data.twilio_token='';data.smtp_pass='';data.get=(key,fallback='')=>data[key]??fallback;const capacity_pools=await db.rows('SELECT * FROM capacity_pools WHERE salon_id=:salonId ORDER BY is_default DESC,name',{salonId});res.render('settings.html',{data,capacity_pools,branding:req.salon});}));
  app.post('/settings/branding',auth,upload.single('logo'),asyncRoute(async(req,res)=>{
    const salonId=req.user.salon_id,name=String(req.body.brand_name||'').trim(),color=String(req.body.primary_color||'').trim().toLowerCase();
    if(!name||!/^#[0-9a-f]{6}$/.test(color)){req.flash('error','Enter a salon name and valid brand colour.');return res.redirect('/settings#branding');}
    let logoUrl=req.salon.logo_url||null;
    if(req.file){const types={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};const ext=types[req.file.mimetype];if(!ext){req.flash('error','Logo must be a PNG, JPG or WebP image.');return res.redirect('/settings#branding');}if(req.file.size>2*1024*1024){req.flash('error','Logo must be smaller than 2 MB.');return res.redirect('/settings#branding');}const directory=path.join(__dirname,'..','..','public','uploads','salons');await fs.mkdir(directory,{recursive:true});const filename=`${salonId}-${crypto.randomBytes(8).toString('hex')}.${ext}`;await fs.writeFile(path.join(directory,filename),req.file.buffer);logoUrl=`/static/uploads/salons/${filename}`;}
    await db.rows('UPDATE salons SET name=:name,primary_color=:color,logo_url=:logoUrl WHERE id=:salonId',{name,color,logoUrl,salonId});
    await db.rows("INSERT INTO settings(salon_id,`key`,`value`) VALUES(:salonId,'salon_name',:name) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)",{salonId,name});
    req.flash('success','Branding updated across the dashboard and booking page.');res.redirect('/settings#branding');
  }));
  app.post('/settings/capacity-pools/add',auth,asyncRoute(async(req,res)=>{const salonId=req.user.salon_id,name=String(req.body.new_pool_name||'').trim(),seats=Number.parseInt(req.body.new_pool_seats,10);if(!name||!Number.isInteger(seats)||seats<1){req.flash('error','Enter a pool name and a seat count of at least 1.');return res.redirect('/settings#capacity');}await db.rows('INSERT INTO capacity_pools (salon_id,name,seats) VALUES (:salonId,:name,:seats)',{salonId,name,seats});req.flash('success',`Capacity pool "${name}" added.`);res.redirect('/settings#capacity');}));
  app.post('/settings/capacity-pools/:id',auth,asyncRoute(async(req,res)=>{const salonId=req.user.salon_id,id=Number(req.params.id),name=String(req.body[`pool_name_${id}`]||'').trim(),seats=Number.parseInt(req.body[`pool_seats_${id}`],10);if(!name||!Number.isInteger(seats)||seats<1){req.flash('error','Enter a pool name and a seat count of at least 1.');return res.redirect('/settings#capacity');}await db.rows('UPDATE capacity_pools SET name=:name,seats=:seats WHERE id=:id AND salon_id=:salonId',{salonId,name,seats,id});req.flash('success','Capacity pool updated.');res.redirect('/settings#capacity');}));
  app.post('/settings/capacity-pools/:id/delete',auth,asyncRoute(async(req,res)=>{const salonId=req.user.salon_id,id=Number(req.params.id),pool=await db.one('SELECT is_default FROM capacity_pools WHERE id=:id AND salon_id=:salonId',{id,salonId});if(!pool){req.flash('error','Capacity pool not found.');return res.redirect('/settings#capacity');}if(pool.is_default){req.flash('error','The default pool cannot be deleted.');return res.redirect('/settings#capacity');}await db.rows('UPDATE services SET capacity_pool_id=NULL WHERE capacity_pool_id=:id AND salon_id=:salonId',{id,salonId});await db.rows('DELETE FROM capacity_pools WHERE id=:id AND salon_id=:salonId',{id,salonId});req.flash('success','Capacity pool removed. Services using it now use the default pool.');res.redirect('/settings#capacity');}));
  app.post('/settings',auth,asyncRoute(async(req,res)=>{const salonId=req.user.salon_id;for(const key of SETTINGS_KEYS){const value=req.body[key]||'';if(['meta_whatsapp_token','twilio_token','smtp_pass'].includes(key)&&!value)continue;await db.rows('INSERT INTO settings (salon_id,`key`,`value`) VALUES (:salonId,:key,:value) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)',{salonId,key,value});}req.flash('success','Settings updated.');res.redirect('/settings');}));
  app.post('/settings/email/test',auth,asyncRoute(async(req,res)=>{
    const recipient=String(req.body.email_test_recipient||'').trim().toLowerCase();
    if(!/^\S+@\S+\.\S+$/.test(recipient)){req.flash('error','Enter a valid recipient email.');return res.redirect('/settings#email');}
    try{
      const result=await sendEmail(req.settings,recipient,`Email connection test from ${req.settings.salon_name||'Aura Salon'}`,`<p>Your salon email connection is working.</p><p>This test was sent from the email configuration saved inside your Aura workspace.</p>`);
      req.flash(result.ok?'success':'error',result.ok?`Test email sent to ${recipient}.`:`Email test failed: ${result.message}`);
    }catch(error){req.flash('error',`Email test failed: ${error.message}`);}
    res.redirect('/settings#email');
  }));
  app.post('/settings/whatsapp/test',auth,asyncRoute(async(req,res)=>{const recipient=String(req.body.test_recipient||'').trim();const result=await sendWhatsApp(req.settings,recipient,'WhatsApp connection test from Aura Salon OS.',null,[]);req.flash(result.ok?'success':'error',result.ok?`WhatsApp test accepted. Message ID: ${result.message}`:`WhatsApp test failed: ${result.message}`);res.redirect('/settings#whatsapp');}));
};
