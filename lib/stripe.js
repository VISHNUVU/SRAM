// Stripe Billing via REST (Checkout for subscribe, Customer Portal for manage/cancel/invoices, signed webhooks for state).
const crypto = require('node:crypto');
const { one, run } = require('./db');
const { safeEq } = require('./util');
const { APP_URL } = require('./email');

const enabled = () => !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);

function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') form(v, key, out); else if (v != null) out.append(key, String(v));
  }
  return out;
}
async function api(path, params) {
  const r = await fetch('https://api.stripe.com/v1/' + path, { method: 'POST', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params), signal: AbortSignal.timeout(20000) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || 'Stripe error'); return j;
}

async function checkout(org, user, seats) {
  const s = await api('checkout/sessions', {
    mode: 'subscription', client_reference_id: org.id, success_url: `${APP_URL()}/#/settings/billing?ok=1`, cancel_url: `${APP_URL()}/#/settings/billing`,
    line_items: { 0: { price: process.env.STRIPE_PRICE_ID, quantity: seats } }, allow_promotion_codes: 'true',
    subscription_data: { metadata: { org_id: org.id } }, ...(org.stripe_customer ? { customer: org.stripe_customer } : { customer_email: user.email }),
  });
  return s.url;
}
async function portal(org) {
  if (!org.stripe_customer) throw new Error('No billing account yet — subscribe first');
  return (await api('billing_portal/sessions', { customer: org.stripe_customer, return_url: `${APP_URL()}/#/settings/billing` })).url;
}

function verify(raw, header) {
  const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET || '').update(`${parts.t}.${raw}`).digest('hex');
  return String(header).split(',').filter(p => p.startsWith('v1=')).some(p => safeEq(p.slice(3), expected));
}

function applySubscription(sub) {
  const org = one('SELECT * FROM orgs WHERE stripe_sub=? OR id=?', sub.id, Number(sub.metadata?.org_id) || 0); if (!org) return;
  const live = ['active', 'trialing', 'past_due'].includes(sub.status);
  run('UPDATE orgs SET plan=?, sub_status=?, seats=?, stripe_sub=?, stripe_customer=COALESCE(stripe_customer,?) WHERE id=?',
    live ? 'pro' : 'free', sub.status, sub.items?.data?.[0]?.quantity || org.seats, sub.id, sub.customer, org.id);
}
function handleEvent(evt) {
  const o = evt.data.object;
  if (evt.type === 'checkout.session.completed' && o.mode === 'subscription') {
    run("UPDATE orgs SET plan='pro', sub_status='active', stripe_customer=?, stripe_sub=? WHERE id=?", o.customer, o.subscription, Number(o.client_reference_id));
  } else if (evt.type.startsWith('customer.subscription.')) applySubscription(evt.type === 'customer.subscription.deleted' ? { ...o, status: 'canceled' } : o);
}

module.exports = { enabled, checkout, portal, verify, handleEvent };
