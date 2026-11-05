// Auth & identity: signup, login (+TOTP 2FA), password reset, invites, Google SSO / Gmail connect, profile, bootstrap.
const { q, one, run, insert, tx } = require('../lib/db');
const U = require('../lib/util');
const { bad, clean, emailOk, normEmail, hashPw, verifyPw, checkPassword, randomToken, sha256, now } = U;
const { createSession, destroySession, isSuperadmin, rateLimit } = require('../lib/http');
const core = require('../lib/core');
const plans = require('../lib/plans');
const email = require('../lib/email');
const google = require('../lib/google');

const DEFAULT_STAGES = [['Lead', 10, 'open'], ['Qualified', 25, 'open'], ['Proposal', 50, 'open'], ['Negotiation', 75, 'open'], ['Won', 100, 'won'], ['Lost', 0, 'lost']];
function seedPipeline(orgId, name = 'Sales pipeline', stages = DEFAULT_STAGES) {
  const pid = insert('pipelines', { org_id: orgId, name, position: one('SELECT COUNT(*) n FROM pipelines WHERE org_id=?', orgId).n });
  stages.forEach(([n, p, k], i) => insert('stages', { org_id: orgId, pipeline_id: pid, name: n, probability: p, kind: k, position: i }));
  return pid;
}
function createOrg(orgName, { name, email: em, pw }) {
  return tx(() => {
    const orgId = insert('orgs', { name: clean(orgName).slice(0, 120), trial_ends_at: plans.TRIAL_DAYS ? now() + plans.TRIAL_DAYS * 864e5 : null, inbound_token: randomToken(12).toLowerCase().replace(/[^a-z0-9]/g, 'x') });
    seedPipeline(orgId);
    for (const [field, op, value, points] of [['email', 'business_email', '', 10], ['title', 'contains', 'director', 10], ['title', 'contains', 'vp', 15], ['title', 'contains', 'founder', 15], ['_opens', 'gt', '2', 10], ['_replies', 'gt', '0', 20]])
      insert('scoring_rules', { org_id: orgId, field, op, value, points });
    const userId = insert('users', { org_id: orgId, email: em, name: clean(name).slice(0, 120), role: 'owner', pw, calendar_token: randomToken(24) });
    return { orgId, userId };
  });
}

// Issue a one-time token (invite/reset). Returns the raw token.
function issueToken(kind, fields, ttlMs) { const t = randomToken(32); insert('tokens', { kind, token_hash: sha256(t), expires: now() + ttlMs, ...fields }); return t; }
function takeToken(kind, t, consume = true) {
  const row = one('SELECT * FROM tokens WHERE kind=? AND token_hash=? AND used=0 AND expires>?', kind, sha256(String(t || '')), now());
  if (!row) bad('this link is invalid or has expired', 400);
  if (consume) run('UPDATE tokens SET used=1 WHERE id=?', row.id);
  return row;
}
// In development without a mail provider, return links in the response so flows are testable.
const devLink = link => (!email.mailConfigured() && process.env.NODE_ENV !== 'production' ? { dev_link: link } : {});

function seatCheck(org, extra = 1) {
  const lim = plans.limits(org).users; if (lim == null) return;
  const used = one('SELECT COUNT(*) n FROM users WHERE org_id=? AND active=1', org.id).n + one("SELECT COUNT(*) n FROM tokens WHERE kind='invite' AND org_id=? AND used=0 AND expires>?", org.id, now()).n;
  if (used + extra > lim) bad(`Your plan allows ${lim} users (including pending invites) — upgrade or add seats under Billing`, 402);
}

function bootstrap(ctx) {
  const { user, org } = ctx; const lim = plans.limits(org);
  const pipelines = q('SELECT * FROM pipelines WHERE org_id=? ORDER BY position, id', org.id).map(p => ({ ...p, stages: q('SELECT * FROM stages WHERE pipeline_id=? ORDER BY position, id', p.id) }));
  return {
    user: { ...user, gmail_connected: !!user.google_email },
    org: { id: org.id, name: org.name, currency: org.currency, timezone: org.timezone, stall_days: org.stall_days, lost_reasons: U.json(org.lost_reasons, []),
      inbound_address: `log+${org.inbound_token}@${process.env.INBOUND_DOMAIN || 'inbound.example.com'}`, inbound_url: `${email.APP_URL()}/api/inbound/${org.inbound_token}`,
      plan: org.plan, sub_status: org.sub_status, seats: org.seats },
    plan: lim, pipelines,
    fields: { contacts: core.fieldDefs(org.id, 'contacts'), companies: core.fieldDefs(org.id, 'companies'), deals: core.fieldDefs(org.id, 'deals') },
    users: q('SELECT id, name, email, role, active, manager_id FROM users WHERE org_id=? ORDER BY name', org.id),
    views: q('SELECT * FROM views WHERE org_id=? AND (user_id=? OR shared=1) ORDER BY name', org.id, user.id),
    features: { ai: require('../lib/ai').enabled(), google: google.enabled(), stripe: require('../lib/stripe').enabled(), twilio: require('../lib/twilio').enabled(), mail: email.mailConfigured(), mail_provider: email.providerName() },
    unread: one('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0', user.id).n,
    impersonating: ctx.impersonatorId ? one('SELECT name, email FROM users WHERE id=?', ctx.impersonatorId) : null,
    superadmin: isSuperadmin(user), app_url: email.APP_URL(),
  };
}

module.exports = function (r) {
  r.get('/api/config', { auth: false }, () => ({ google: google.enabled() }));

  r.post('/api/signup', { auth: false, rate: 'public' }, ctx => {
    const { org, name, email: em, password } = ctx.body; const e = normEmail(em);
    if (!clean(org) || !clean(name) || !emailOk(e)) bad('company, name and a valid email are required');
    checkPassword(password);
    if (one('SELECT 1 FROM users WHERE email=?', e)) bad('that email is already registered — sign in instead', 409);
    const { orgId, userId } = createOrg(org, { name, email: e, pw: hashPw(password) });
    createSession(ctx.res, userId);
    core.audit({ user: { id: userId, org_id: orgId }, ip: ctx.ip }, 'signup', 'org', orgId);
  });

  const fails = new Map();
  r.post('/api/login', { auth: false, rate: 'public' }, ctx => {
    const e = normEmail(ctx.body.email) || '', key = e + '|' + ctx.ip;
    const f = (fails.get(key) || []).filter(t => now() - t < 15 * 60e3); fails.set(key, f);
    if (f.length >= 8) bad('too many failed attempts — try again in 15 minutes', 429);
    const u = one('SELECT * FROM users WHERE email=?', e);
    if (!u || !u.active || !verifyPw(String(ctx.body.password || ''), u.pw)) { f.push(now()); bad('invalid email or password', 401); }
    fails.delete(key);
    if (u.totp_enabled) return { need_2fa: true, ticket: U.sign({ uid: u.id, k: '2fa' }, 5 * 60e3) };
    createSession(ctx.res, u.id);
    core.audit({ user: u, ip: ctx.ip }, 'login', 'user', u.id);
  });
  r.post('/api/login/2fa', { auth: false, rate: 'public' }, ctx => {
    const t = U.unsign(ctx.body.ticket); if (!t || t.k !== '2fa') bad('login expired — sign in again', 401);
    rateLimit('2fa:' + t.uid, 6, 5 * 60e3);
    const u = one('SELECT * FROM users WHERE id=? AND active=1', t.uid);
    if (!u || !U.verifyTotp(U.decrypt(u.totp_secret), ctx.body.code)) bad('invalid code', 401);
    createSession(ctx.res, u.id);
    core.audit({ user: u, ip: ctx.ip }, 'login', 'user', u.id, { mfa: true });
  });
  r.post('/api/logout', { auth: false }, ctx => { destroySession(ctx.req, ctx.res); });
  r.post('/api/logout-all', ctx => { run('DELETE FROM sessions WHERE user_id=?', ctx.user.id); destroySession(ctx.req, ctx.res); });

  r.get('/api/me', ctx => bootstrap(ctx));
  r.patch('/api/me', ctx => {
    const b = ctx.body, o = {};
    if ('name' in b) { if (!clean(b.name)) bad('name is required'); o.name = clean(b.name).slice(0, 120); }
    if ('phone' in b) o.phone = clean(b.phone) || null;
    if ('notify_email' in b) o.notify_email = b.notify_email ? 1 : 0;
    if (b.new_password) {
      const u = one('SELECT pw FROM users WHERE id=?', ctx.user.id);
      if (u.pw && !verifyPw(String(b.current_password || ''), u.pw)) bad('current password is incorrect', 403);
      checkPassword(b.new_password); o.pw = hashPw(b.new_password);
      run('DELETE FROM sessions WHERE user_id=?', ctx.user.id); createSession(ctx.res, ctx.user.id);
      core.audit(ctx, 'password_change', 'user', ctx.user.id);
    }
    if (Object.keys(o).length) run(`UPDATE users SET ${Object.keys(o).map(k => k + '=?').join(',')} WHERE id=?`, ...Object.values(o), ctx.user.id);
  });
  r.post('/api/me/calendar-token', ctx => { const t = randomToken(24); run('UPDATE users SET calendar_token=? WHERE id=?', t, ctx.user.id); return { calendar_token: t }; });

  // password reset
  r.post('/api/forgot', { auth: false, rate: 'public' }, ctx => {
    const u = one('SELECT * FROM users WHERE email=? AND active=1', normEmail(ctx.body.email) || '');
    if (!u) return { ok: true };
    const link = `${email.APP_URL()}/#/reset?token=${issueToken('reset', { user_id: u.id, org_id: u.org_id }, 3600e3)}`;
    require('../lib/core').enqueue('system_email', { to: u.email, subject: 'Reset your PipelineHQ password', text: `Hi ${u.name},\n\nReset your password here (valid for 1 hour):\n${link}\n\nIf you didn't ask for this, ignore this email.` });
    return { ok: true, ...devLink(link) };
  });
  r.post('/api/reset', { auth: false, rate: 'public' }, ctx => {
    checkPassword(ctx.body.password);
    const t = takeToken('reset', ctx.body.token);
    run('UPDATE users SET pw=? WHERE id=?', hashPw(ctx.body.password), t.user_id);
    run('DELETE FROM sessions WHERE user_id=?', t.user_id);
    createSession(ctx.res, t.user_id);
    core.audit({ user: { id: t.user_id, org_id: t.org_id }, ip: ctx.ip }, 'password_reset', 'user', t.user_id);
  });

  // invites
  r.post('/api/team/invite', { roles: ['owner', 'admin'] }, ctx => {
    const e = normEmail(ctx.body.email), role = ctx.body.role || 'rep';
    if (!emailOk(e)) bad('valid email required');
    if (!['admin', 'manager', 'rep'].includes(role)) bad('role must be admin, manager or rep');
    if (one('SELECT 1 FROM users WHERE email=?', e)) bad('that email already has an account', 409);
    seatCheck(ctx.org);
    run("UPDATE tokens SET used=1 WHERE kind='invite' AND org_id=? AND email=?", ctx.org.id, e);
    const managerId = ctx.body.manager_id ? one('SELECT id FROM users WHERE id=? AND org_id=?', Number(ctx.body.manager_id), ctx.org.id)?.id : null;
    const link = `${email.APP_URL()}/#/accept?token=${issueToken('invite', { org_id: ctx.org.id, email: e, role, user_id: managerId }, 7 * 864e5)}`;
    core.enqueue('system_email', { to: e, subject: `${ctx.user.name} invited you to ${ctx.org.name} on PipelineHQ`, text: `${ctx.user.name} invited you to join ${ctx.org.name}.\n\nAccept the invite (valid 7 days):\n${link}` });
    core.audit(ctx, 'invite', 'user', null, { email: e, role });
    return { ok: true, ...devLink(link) };
  });
  r.get('/api/team/invites', { roles: ['owner', 'admin'] }, ctx => q("SELECT id, email, role, expires FROM tokens WHERE kind='invite' AND org_id=? AND used=0 AND expires>?", ctx.org.id, now()));
  r.del('/api/team/invites/:id', { roles: ['owner', 'admin'] }, ctx => { run("UPDATE tokens SET used=1 WHERE id=? AND org_id=? AND kind='invite'", Number(ctx.params.id), ctx.org.id); });
  r.get('/api/invite/:token', { auth: false }, ctx => { const t = takeToken('invite', ctx.params.token, false); return { email: t.email, org: one('SELECT name FROM orgs WHERE id=?', t.org_id).name }; });
  r.post('/api/invite/accept', { auth: false, rate: 'public' }, ctx => {
    if (!clean(ctx.body.name)) bad('name is required'); checkPassword(ctx.body.password);
    const t = takeToken('invite', ctx.body.token);
    if (one('SELECT 1 FROM users WHERE email=?', t.email)) bad('that email already has an account', 409);
    const id = insert('users', { org_id: t.org_id, email: t.email, name: clean(ctx.body.name).slice(0, 120), role: t.role, manager_id: t.user_id, pw: hashPw(ctx.body.password), calendar_token: randomToken(24) });
    createSession(ctx.res, id);
    core.audit({ user: { id, org_id: t.org_id }, ip: ctx.ip }, 'join', 'user', id);
  });

  // 2FA (TOTP)
  r.post('/api/2fa/setup', ctx => {
    const secret = U.newTotpSecret();
    run('UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?', U.encrypt(secret), ctx.user.id);
    return { secret, otpauth: `otpauth://totp/PipelineHQ:${encodeURIComponent(ctx.user.email)}?secret=${secret}&issuer=PipelineHQ` };
  });
  r.post('/api/2fa/enable', ctx => {
    const u = one('SELECT totp_secret FROM users WHERE id=?', ctx.user.id);
    if (!u.totp_secret || !U.verifyTotp(U.decrypt(u.totp_secret), ctx.body.code)) bad('that code is not valid — check your authenticator app');
    run('UPDATE users SET totp_enabled=1 WHERE id=?', ctx.user.id); core.audit(ctx, '2fa_enabled', 'user', ctx.user.id);
  });
  r.post('/api/2fa/disable', ctx => {
    const u = one('SELECT pw, totp_secret FROM users WHERE id=?', ctx.user.id);
    if (u.pw && !verifyPw(String(ctx.body.password || ''), u.pw)) bad('password is incorrect', 403);
    if (!U.verifyTotp(U.decrypt(u.totp_secret), ctx.body.code)) bad('invalid code', 403);
    run('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?', ctx.user.id); core.audit(ctx, '2fa_disabled', 'user', ctx.user.id);
  });

  // Google SSO + Gmail connect
  r.get('/auth/google/start', { auth: false }, ctx => {
    if (!google.enabled()) bad('Google sign-in is not configured', 501);
    const mode = ctx.query.get('mode') === 'connect' ? 'connect' : 'login';
    if (mode === 'connect' && !ctx.user) bad('sign in first', 401);
    ctx.redirect(google.authUrl(mode, ctx.user?.id));
  });
  r.get('/auth/google/callback', { auth: false }, async ctx => {
    const st = U.unsign(ctx.query.get('state'));
    if (!st || !ctx.query.get('code')) return ctx.redirect('/#/login?error=google');
    let g; try { g = await google.exchange(ctx.query.get('code')); } catch (e) { return ctx.redirect('/#/login?error=' + encodeURIComponent(e.message)); }
    if (st.mode === 'connect') {
      if (!ctx.user || ctx.user.id !== st.uid) return ctx.redirect('/#/login');
      google.saveConnection(ctx.user.id, g.email, g.refresh); core.audit(ctx, 'gmail_connected', 'user', ctx.user.id, { email: g.email });
      return ctx.redirect('/#/settings/profile?gmail=1');
    }
    let u = one('SELECT * FROM users WHERE email=?', g.email);
    if (u && !u.active) return ctx.redirect('/#/login?error=deactivated');
    if (!u) { const { userId } = createOrg(`${g.name}'s workspace`, { name: g.name, email: g.email, pw: null }); u = { id: userId }; }
    createSession(ctx.res, u.id);
    ctx.redirect('/#/');
  });
  r.post('/api/google/disconnect', ctx => { run('UPDATE users SET google_refresh=NULL, google_email=NULL WHERE id=?', ctx.user.id); });
  r.post('/api/google/sync', async ctx => {
    const u = one('SELECT * FROM users WHERE id=?', ctx.user.id); if (!u.google_refresh) bad('connect Gmail first');
    return { logged: await google.syncUser(u) };
  });

  return { createOrg, seedPipeline, seatCheck, DEFAULT_STAGES };
};
module.exports.seedPipeline = seedPipeline;
module.exports.seatCheck = seatCheck;
