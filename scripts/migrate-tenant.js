'use strict';
require('dotenv').config();
const mysql=require('mysql2/promise');

const sourceDb=process.env.SOURCE_DB_NAME;
const targetDb=process.env.TARGET_DB_NAME||process.env.DB_NAME;
const slug=String(process.env.TENANT_SLUG||'').trim().toLowerCase();
const salonName=String(process.env.TENANT_NAME||'').trim();
if(!sourceDb||!targetDb||!slug||!salonName)throw new Error('SOURCE_DB_NAME, TARGET_DB_NAME, TENANT_SLUG and TENANT_NAME are required');
if(sourceDb===targetDb)throw new Error('Source and target databases must be different');

const config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD,dateStrings:true,decimalNumbers:true,charset:'utf8mb4'};
const source=mysql.createPool({...config,database:sourceDb,connectionLimit:2});
const target=mysql.createPool({...config,database:targetDb,connectionLimit:2});

async function sourceRows(sql,params=[]){const [rows]=await source.execute(sql,params);return rows;}
async function targetColumns(connection,table){const [rows]=await connection.query(`SHOW COLUMNS FROM \`${table}\``);return new Set(rows.map(row=>row.Field));}
async function sourceColumns(table){const rows=await sourceRows(`SHOW COLUMNS FROM \`${table}\``);return new Set(rows.map(row=>row.Field));}

async function main(){
  const connection=await target.getConnection();
  let stage='starting';
  try{
    await connection.beginTransaction();
    const [[existing]]=await connection.execute('SELECT id FROM salons WHERE slug=?',[slug]);
    if(existing)throw new Error(`Tenant ${slug} already exists; migration stopped without changes`);
    stage='creating salon';const [salonResult]=await connection.query(`INSERT INTO salons(name,slug,status,owner_name,owner_email,owner_mobile,payment_status,payment_notes,access_starts_at,access_ends_at,approved_at)
      VALUES(?,?,'Active',?,?,?,'Waived','Raja Rani pilot tenant',NOW(),NULL,NOW())`,[salonName,slug,process.env.TENANT_OWNER_NAME||'Raja Rani Owner',process.env.TENANT_OWNER_EMAIL||'owner@rajarani.local',process.env.TENANT_OWNER_MOBILE||null]);
    const salonId=salonResult.insertId,maps={};

    async function copy(table,{map=true,transform=()=>({}),after}={}){
      const rows=await sourceRows(`SELECT * FROM \`${table}\` ORDER BY ${map?'id':'1'}`),sourceCols=await sourceColumns(table),targetCols=await targetColumns(connection,table);
      const common=[...sourceCols].filter(column=>targetCols.has(column)&&!['id','salon_id'].includes(column));
      if(map)maps[table]=new Map();
      for(const row of rows){try{const changes=transform(row)||{},values={salon_id:salonId};for(const column of common)values[column]=Object.hasOwn(changes,column)?changes[column]:row[column];for(const [column,value]of Object.entries(changes))if(targetCols.has(column))values[column]=value;const columns=Object.keys(values),placeholders=columns.map(()=>'?').join(',');const [result]=await connection.execute(`INSERT INTO \`${table}\` (${columns.map(column=>`\`${column}\``).join(',')}) VALUES (${placeholders})`,columns.map(column=>values[column]));if(map)maps[table].set(Number(row.id),result.insertId);if(after)await after(row,result.insertId);}catch(error){throw new Error(`${table} source row ${row.id??'n/a'}: ${error.message}`);}}
      return rows.length;
    }
    const id=(table,value)=>value==null?null:(maps[table]?.get(Number(value))||null);
    const counts={};
    stage='capacity pools';counts.capacity_pools=await copy('capacity_pools');
    stage='staff';counts.staff=await copy('staff');
    counts.services=await copy('services',{transform:row=>({capacity_pool_id:id('capacity_pools',row.capacity_pool_id)})});
    counts.products=await copy('products');counts.packages=await copy('packages');counts.expenses=await copy('expenses');
    const customerReferrers=[];
    counts.customers=await copy('customers',{transform:()=>({referred_by_id:null}),after:(row,newId)=>customerReferrers.push([row.referred_by_id,newId])});
    for(const [oldReferrer,newId]of customerReferrers)if(oldReferrer)await connection.execute('UPDATE customers SET referred_by_id=? WHERE id=? AND salon_id=?',[id('customers',oldReferrer),newId,salonId]);
    const userCreators=[];
    counts.users=await copy('users',{transform:row=>({staff_id:id('staff',row.staff_id),created_by:null}),after:(row,newId)=>userCreators.push([row.created_by,newId])});
    for(const [oldCreator,newId]of userCreators)if(oldCreator)await connection.execute('UPDATE users SET created_by=? WHERE id=? AND salon_id=?',[id('users',oldCreator),newId,salonId]);
    await connection.execute("UPDATE users SET role='owner' WHERE salon_id=? AND id=(SELECT chosen FROM (SELECT MIN(id) chosen FROM users WHERE salon_id=?) x)",[salonId,salonId]);
    counts.sales=await copy('sales',{transform:row=>({customer_id:id('customers',row.customer_id),referrer_id:id('customers',row.referrer_id)})});
    counts.sale_items=await copy('sale_items',{transform:row=>({sale_id:id('sales',row.sale_id)})});
    counts.appointments=await copy('appointments',{transform:row=>({customer_id:id('customers',row.customer_id),service_id:id('services',row.service_id),staff_id:id('staff',row.staff_id)})});
    counts.loyalty_transactions=await copy('loyalty_transactions',{transform:row=>({customer_id:id('customers',row.customer_id),ref_id:row.ref_type==='sale'?id('sales',row.ref_id):row.ref_id})});
    counts.referral_credit_transactions=await copy('referral_credit_transactions',{transform:row=>({customer_id:id('customers',row.customer_id),referee_id:id('customers',row.referee_id),sale_id:id('sales',row.sale_id)})});
    counts.audit_logs=await copy('audit_logs',{transform:row=>({user_id:id('users',row.user_id)})});
    counts.settings=await copy('settings',{map:false});
    const serviceStaff=await sourceRows('SELECT * FROM service_staff');counts.service_staff=0;
    for(const row of serviceStaff){const serviceId=id('services',row.service_id),staffId=id('staff',row.staff_id);if(serviceId&&staffId){await connection.execute('INSERT INTO service_staff(salon_id,service_id,staff_id) VALUES(?,?,?)',[salonId,serviceId,staffId]);counts.service_staff++;}}
    if(!counts.capacity_pools){const [pool]=await connection.execute("INSERT INTO capacity_pools(salon_id,name,seats,is_default) VALUES(?,'General',1,1)",[salonId]);await connection.execute('UPDATE services SET capacity_pool_id=? WHERE salon_id=? AND capacity_pool_id IS NULL',[pool.insertId,salonId]);}
    const [[sourceTotals]]=await source.execute('SELECT COUNT(*) invoices,COALESCE(SUM(final_amount),0) total,COALESCE(SUM(paid_amount),0) paid,COALESCE(SUM(pending_amount),0) pending FROM sales WHERE cancelled=0');
    const [[targetTotals]]=await connection.execute('SELECT COUNT(*) invoices,COALESCE(SUM(final_amount),0) total,COALESCE(SUM(paid_amount),0) paid,COALESCE(SUM(pending_amount),0) pending FROM sales WHERE salon_id=? AND cancelled=0',[salonId]);
    for(const key of ['invoices','total','paid','pending'])if(Number(sourceTotals[key])!==Number(targetTotals[key]))throw new Error(`Financial validation failed for ${key}: source ${sourceTotals[key]}, target ${targetTotals[key]}`);
    await connection.commit();
    console.log(JSON.stringify({ok:true,salon_id:salonId,slug,counts,financials:targetTotals},null,2));
  }catch(error){await connection.rollback();throw new Error(`${stage}: ${error.message}`);}finally{connection.release();await source.end();await target.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
