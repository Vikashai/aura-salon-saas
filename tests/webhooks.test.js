'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {validSignature,extractEvents}=require('../src/routes/webhooks');

test('validates Meta SHA-256 webhook signatures',()=>{
  const body=Buffer.from('{"object":"whatsapp_business_account"}'),secret='app-secret';
  const signature=`sha256=${crypto.createHmac('sha256',secret).update(body).digest('hex')}`;
  assert.equal(validSignature(body,signature,secret),true);
  assert.equal(validSignature(body,'sha256=bad',secret),false);
});

test('extracts tenant routing and delivery events',()=>{
  const events=extractEvents({entry:[{changes:[{value:{metadata:{phone_number_id:'123'},messages:[{id:'wamid.in',from:'9199',type:'text'}],statuses:[{id:'wamid.out',recipient_id:'9188',status:'delivered'}]}}]}]});
  assert.equal(events.length,2);
  assert.deepEqual(events.map(event=>[event.phoneNumberId,event.direction,event.messageId]),[['123','inbound','wamid.in'],['123','status','wamid.out']]);
});
