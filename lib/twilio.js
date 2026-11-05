// Click-to-call via Twilio: rings the rep's phone first, then bridges to the contact.
const { bad } = require('./util');
const enabled = () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
const E164 = /^\+[1-9]\d{6,14}$/;
const normPhone = p => String(p || '').replace(/[\s().-]/g, '');

async function dial(repPhone, contactPhone) {
  repPhone = normPhone(repPhone); contactPhone = normPhone(contactPhone);
  if (!E164.test(repPhone)) bad('Add your phone number in E.164 format (e.g. +14155550123) under Settings → Profile');
  if (!E164.test(contactPhone)) bad('Contact phone must be in E.164 format, e.g. +14155550123');
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const twiml = `<Response><Dial callerId="${process.env.TWILIO_FROM}">${contactPhone}</Dial></Response>`;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, { method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: repPhone, From: process.env.TWILIO_FROM, Twiml: twiml }), signal: AbortSignal.timeout(15000) });
  const j = await r.json(); if (!r.ok) bad(j.message || 'Twilio call failed', 502);
  return j.sid;
}
module.exports = { enabled, dial };
