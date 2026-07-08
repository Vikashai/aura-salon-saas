'use strict';
const crypto = require('node:crypto');
const db = require('../db');
const { asyncRoute } = require('../helpers');

function validSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected=`sha256=${crypto.createHmac('sha256',secret).update(rawBody).digest('hex')}`;
  const supplied=String(signature);
  return supplied.length===expected.length&&crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected));
}

function extractEvents(payload) {
  const events=[];
  for(const entry of payload?.entry||[])for(const change of entry?.changes||[]){
    const value=change?.value||{},phoneNumberId=String(value?.metadata?.phone_number_id||'');
    if(!phoneNumberId)continue;
    for(const message of value.messages||[])events.push({phoneNumberId,messageId:message.id||null,direction:'inbound',eventType:message.type||'unknown',deliveryStatus:null,contactNumber:message.from||null,payload:message});
    for(const status of value.statuses||[])events.push({phoneNumberId,messageId:status.id||null,direction:'status',eventType:'delivery',deliveryStatus:status.status||null,contactNumber:status.recipient_id||null,payload:status});
  }
  return events;
}

module.exports = app => {
  app.get('/webhooks/meta/whatsapp',(req,res)=>{
    const mode=String(req.query['hub.mode']||''),token=String(req.query['hub.verify_token']||''),challenge=String(req.query['hub.challenge']||'');
    if(mode==='subscribe'&&process.env.META_WEBHOOK_VERIFY_TOKEN&&token===process.env.META_WEBHOOK_VERIFY_TOKEN)return res.status(200).send(challenge);
    return res.sendStatus(403);
  });
  app.post('/webhooks/meta/whatsapp',asyncRoute(async(req,res)=>{
    if(!validSignature(req.rawBody,req.get('x-hub-signature-256'),process.env.META_APP_SECRET))return res.sendStatus(401);
    const bodyHash=crypto.createHash('sha256').update(req.rawBody).digest('hex'),events=extractEvents(req.body);
    for(let index=0;index<events.length;index++){
      const event=events[index],salon=await db.platformOne("SELECT salon_id FROM settings WHERE `key`='meta_phone_number_id' AND `value`=? LIMIT 1",[event.phoneNumberId]);
      if(!salon){console.warn(`WhatsApp webhook received for unknown phone number ID ${event.phoneNumberId}`);continue;}
      const eventHash=crypto.createHash('sha256').update(`${bodyHash}:${index}`).digest('hex');
      await db.rows(`INSERT IGNORE INTO whatsapp_webhook_events(salon_id,event_hash,phone_number_id,message_id,direction,event_type,delivery_status,contact_number,payload)
        VALUES(:salonId,:eventHash,:phoneNumberId,:messageId,:direction,:eventType,:deliveryStatus,:contactNumber,:payload)`,{salonId:salon.salon_id,eventHash,phoneNumberId:event.phoneNumberId,messageId:event.messageId,direction:event.direction,eventType:event.eventType,deliveryStatus:event.deliveryStatus,contactNumber:event.contactNumber,payload:JSON.stringify(event.payload)});
    }
    res.sendStatus(200);
  }));
};
module.exports.validSignature=validSignature;
module.exports.extractEvents=extractEvents;
