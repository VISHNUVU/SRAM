// Plans, trials and feature entitlements.
const { bad } = require('./util');

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS ?? 14);
const PLANS = {
  free: { label: 'Free', users: 3, contacts: 500, pipelines: 1, features: [] },
  pro: { label: 'Pro', users: null, contacts: null, pipelines: null, features: ['automation', 'sequences', 'ai', 'api', 'forecast', 'quotes', 'custom_fields', 'booking', 'forms'] },
};

function effectivePlan(org) {
  if (org.plan === 'pro' && (!org.sub_status || ['active', 'trialing', 'past_due'].includes(org.sub_status))) return 'pro';
  if (org.trial_ends_at && org.trial_ends_at > Date.now()) return 'pro';
  return 'free';
}
function limits(org) {
  const p = effectivePlan(org), def = PLANS[p];
  // On paid Pro, seats come from the subscription quantity; trials are unlimited.
  const users = p === 'pro' && org.plan === 'pro' && process.env.STRIPE_SECRET_KEY ? org.seats : def.users;
  return { plan: p, label: def.label, users, contacts: def.contacts, pipelines: def.pipelines, features: def.features,
    trial_days_left: org.plan !== 'pro' && org.trial_ends_at > Date.now() ? Math.ceil((org.trial_ends_at - Date.now()) / 864e5) : null };
}
function requireFeature(org, feature) {
  if (!limits(org).features.includes(feature)) bad(`This feature needs the Pro plan — upgrade under Settings → Billing`, 402);
}
module.exports = { PLANS, TRIAL_DAYS, effectivePlan, limits, requireFeature };
