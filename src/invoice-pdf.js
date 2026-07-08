'use strict';

const PDFDocument = require('pdfkit');

const amount = value => `Rs ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits:2, maximumFractionDigits:2 })}`;
const safe = value => String(value ?? '').trim();

function generateInvoicePdf(sale, items, settings = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size:'A4', margin:48, info:{ Title:`Invoice ${sale.invoice_no}` } });
    const chunks=[];doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
    const dark='#20211f',muted='#6f756d',lime='#dfff3f',line='#dfe3da',soft='#f5f6f1';
    const salon=safe(settings.salon_name)||'Aura Salon',address=safe(settings.address),gst=safe(settings.gst_number);

    doc.roundedRect(48,42,32,32,10).fill(lime).fillColor(dark).font('Helvetica-Bold').fontSize(17).text('*',58,49);
    doc.fontSize(20).text(salon,92,47,{width:270});
    doc.font('Helvetica').fillColor(muted).fontSize(9).text(address||'Salon invoice',92,72,{width:280});
    if(gst)doc.text(`GSTIN: ${gst}`,92,86);
    doc.fillColor(muted).font('Helvetica-Bold').fontSize(8).text('TAX INVOICE',390,48,{align:'right',width:155});
    doc.fillColor(dark).fontSize(18).text(safe(sale.invoice_no),350,65,{align:'right',width:195});
    doc.fillColor(muted).font('Helvetica').fontSize(9).text(safe(sale.invoice_date),390,91,{align:'right',width:155});

    doc.roundedRect(48,122,497,94,14).fill(soft);
    doc.fillColor(muted).font('Helvetica-Bold').fontSize(8).text('BILLED TO',66,140);
    doc.fillColor(dark).fontSize(13).text(safe(sale.customer)||'Walk-in customer',66,157,{width:250});
    doc.fillColor(muted).font('Helvetica').fontSize(9).text(safe(sale.mobile),66,178);
    const customerAddress=[sale.address,sale.city,sale.state].map(safe).filter(Boolean).join(', ');if(customerAddress)doc.text(customerAddress,66,193,{width:260});
    doc.fillColor(muted).font('Helvetica-Bold').fontSize(8).text('PAYMENT',390,140,{align:'right',width:130});
    doc.fillColor(dark).fontSize(12).text(safe(sale.payment_mode)||'Not recorded',350,157,{align:'right',width:170});
    doc.fillColor(muted).font('Helvetica').fontSize(9).text(safe(sale.payment_status),390,178,{align:'right',width:130});

    let y=244;const cols={item:58,provider:285,qty:396,rate:432,total:500};
    const header=()=>{doc.roundedRect(48,y,497,27,7).fill(dark);doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8).text('ITEM',cols.item,y+9).text('PROVIDER',cols.provider,y+9).text('QTY',cols.qty,y+9,{width:28,align:'right'}).text('RATE',cols.rate,y+9,{width:58,align:'right'}).text('AMOUNT',cols.total,y+9,{width:35,align:'right'});y+=36;};
    header();
    for(const item of items){
      if(y>690){doc.addPage();y=55;header();}
      const lineTotal=Number(item.quantity||0)*Number(item.price||0)-Number(item.discount||0);
      doc.fillColor(dark).font('Helvetica-Bold').fontSize(9).text(safe(item.item_name),cols.item,y,{width:210});
      doc.fillColor(muted).font('Helvetica').fontSize(8).text(safe(item.item_type),cols.item,y+14,{width:210});
      doc.fillColor(dark).fontSize(9).text(safe(item.staff_name)||'-',cols.provider,y,{width:95}).text(safe(item.quantity),cols.qty,y,{width:28,align:'right'}).text(amount(item.price),cols.rate,y,{width:58,align:'right'}).text(amount(lineTotal),475,y,{width:70,align:'right'});
      y+=34;doc.moveTo(48,y-7).lineTo(545,y-7).strokeColor(line).lineWidth(.6).stroke();
    }
    y=Math.max(y+10,470);
    const totalRow=(label,value,bold=false)=>{doc.fillColor(bold?dark:muted).font(bold?'Helvetica-Bold':'Helvetica').fontSize(bold?12:9).text(label,350,y,{width:90}).text(amount(value),440,y,{width:105,align:'right'});y+=bold?25:18;};
    totalRow('Subtotal',sale.subtotal);totalRow('Discount',-Number(sale.discount||0));if(Number(sale.gst_enabled))totalRow(`GST (${sale.gst_percent}%)`,sale.tax_amount);totalRow('Total',sale.final_amount,true);totalRow('Paid',sale.paid_amount);totalRow('Balance due',sale.pending_amount,true);
    doc.fillColor(muted).font('Helvetica').fontSize(9).text(safe(sale.notes)||'Thank you for choosing us. We look forward to welcoming you again.',48,Math.max(y+10,620),{width:260,lineGap:3});
    doc.moveTo(48,755).lineTo(545,755).strokeColor(line).stroke();doc.fontSize(8).text('Computer-generated invoice',48,766).text('Amounts are in Indian Rupees (INR)',360,766,{width:185,align:'right'});
    doc.end();
  });
}

module.exports={generateInvoicePdf};
