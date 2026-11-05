// End-to-end API tests across every feature area. Run: npm test
const os = require('node:os'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
Object.assign(process.env, { NODE_ENV: 'test', DB_FILE: ':memory:', DATA_DIR: tmp, ALLOW_PRIVATE_URLS: '1', SEQUENCE_DAY_MS: '1', SUPERADMIN_EMAILS: 'ann@acme.com', TRIAL_DAYS: '14', RATE_LIMIT: '100000', RATE_LIMIT_PUBLIC: '100000' });
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'STRIPE_SECRET_KEY', 'RESEND_API_KEY', 'POSTMARK_TOKEN', 'GOOGLE_CLIENT_ID', 'TWILIO_ACCOUNT_SID']) delete process.env[k];
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const server = require('./server');
const worker = require('./lib/worker');
const { totpAt } = require('./lib/util');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0; const results = [];
async function t(name, fn) { try { await fn(); passed++; results.push('  ✓ ' + name); } catch (e) { results.push('  ✗ ' + name + '\n    ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; } }

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const client = () => {
    let jar = {};
    const f = async (m, p, b, extra = {}) => {
      const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(b !== undefined && !extra.raw ? { 'Content-Type': 'application/json' } : {}), ...extra.headers };
      const r = await fetch(base + p, { method: m, headers, body: extra.raw ?? (b !== undefined ? JSON.stringify(b) : undefined), redirect: 'manual' });
      for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); if (/Max-Age=0/.test(c)) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = v; }
      const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
      return { s: r.status, j, h: r.headers };
    };
    return f;
  };
  const ok = r => { assert.ok(r.s < 300, `HTTP ${r.s}: ${JSON.stringify(r.j)}`); return r.j; };
  const A = client(), B = client(), R = client(), M = client(); // Ann (owner), Bob (other org), Rita (rep), Max (manager)

  // webhook receiver
  const received = [];
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { received.push({ headers: req.headers, body: b }); res.end('ok'); }); }).listen(0);
  const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;

  let me, pipeline, stage, ids = {};
  await t('signup creates workspace with trial, default pipeline and owner', async () => {
    ok(await A('POST', '/api/signup', { org: 'Acme', name: 'Ann Owner', email: 'ann@acme.com', password: 'password123' }));
    ok(await B('POST', '/api/signup', { org: 'Globex', name: 'Bob', email: 'bob@globex.com', password: 'password123' }));
    assert.equal((await A('POST', '/api/signup', { org: 'X', name: 'Dup', email: 'ann@acme.com', password: 'password123' })).s, 409);
    me = ok(await A('GET', '/api/me'));
    assert.equal(me.user.role, 'owner'); assert.equal(me.plan.plan, 'pro'); assert.ok(me.plan.trial_days_left > 0);
    pipeline = me.pipelines[0]; assert.equal(pipeline.stages.length, 6); stage = Object.fromEntries(pipeline.stages.map(s => [s.name, s.id]));
  });
  await t('invites: rep + manager join via invite link; hierarchy set', async () => {
    const inv = ok(await A('POST', '/api/team/invite', { email: 'rita@acme.com', role: 'rep' }));
    const token = new URL(inv.dev_link.replace('/#/', '/')).searchParams.get('token');
    assert.equal(ok(await R('GET', '/api/invite/' + token)).org, 'Acme');
    ok(await R('POST', '/api/invite/accept', { token, name: 'Rita Rep', password: 'password123' }));
    assert.equal((await R('POST', '/api/invite/accept', { token, name: 'x', password: 'password123' })).s, 400, 'token reuse blocked');
    const inv2 = ok(await A('POST', '/api/team/invite', { email: 'max@acme.com', role: 'manager' }));
    ok(await M('POST', '/api/invite/accept', { token: new URL(inv2.dev_link.replace('/#/', '/')).searchParams.get('token'), name: 'Max Manager', password: 'password123' }));
    const team = ok(await A('GET', '/api/team')); ids.rita = team.find(u => u.email === 'rita@acme.com').id; ids.max = team.find(u => u.email === 'max@acme.com').id; ids.ann = me.user.id;
    ok(await A('PATCH', '/api/team/' + ids.rita, { manager_id: ids.max }));
    assert.equal((await A('PATCH', '/api/team/' + ids.max, { manager_id: ids.rita })).s, 400, 'reporting loop rejected');
    assert.equal((await R('POST', '/api/team/invite', { email: 'x@acme.com' })).s, 403, 'reps cannot invite');
  });
  await t('custom fields validate on records', async () => {
    ok(await A('POST', '/api/fields', { entity: 'deals', label: 'Contract type', type: 'select', options: ['Annual', 'Monthly'] }));
    ok(await A('POST', '/api/fields', { entity: 'contacts', label: 'LinkedIn', type: 'url' }));
    assert.equal((await A('POST', '/api/fields', { entity: 'deals', label: 'Bad', type: 'select', options: [] })).s, 400);
  });
  await t('contacts: create, duplicate detection, scoring, custom fields', async () => {
    const c = ok(await R('POST', '/api/contacts', { name: 'Peter Gibbons', email: 'peter@initech.com', title: 'VP Engineering', company_name: 'Initech', custom: { linkedin: 'linkedin.com/in/peter' } }));
    ids.peter = c.id; ids.initech = c.company_id; assert.equal(c.owner_id, ids.rita); assert.equal(c.custom.linkedin, 'https://linkedin.com/in/peter');
    assert.ok(c.lead_score >= 25, 'business email + VP title scored: ' + c.lead_score);
    const dup = await R('POST', '/api/contacts', { name: 'Pete', email: 'PETER@initech.com' }); assert.equal(dup.s, 409); assert.equal(dup.j.duplicate_id, c.id);
    ids.annc = ok(await A('POST', '/api/contacts', { name: 'Ann Contact', email: 'ac@corp.com' })).id;
  });
  await t('visibility: reps see own, managers see team, owner sees all', async () => {
    assert.equal(ok(await R('GET', '/api/contacts')).total, 1);
    assert.equal((await R('GET', '/api/contacts/' + ids.annc)).s, 404);
    assert.equal(ok(await M('GET', '/api/contacts')).total, 1, 'manager sees report Rita');
    assert.equal(ok(await A('GET', '/api/contacts')).total, 2);
    assert.equal((await R('DELETE', '/api/contacts/' + ids.annc)).s, 404);
  });
  await t('deals: stage history, won → customer, custom select, filters', async () => {
    assert.equal((await R('POST', '/api/deals', { title: 'x', custom: { contract_type: 'Weekly' } })).s, 400);
    const d = ok(await R('POST', '/api/deals', { title: 'Initech platform', value: 12000, contact_id: ids.peter, close_date: new Date().toISOString().slice(0, 10), custom: { contract_type: 'Annual' } }));
    ids.deal = d.id; assert.equal(d.company_id, ids.initech, 'company inferred from contact'); assert.equal(d.stage_id, stage.Lead);
    ok(await R('PATCH', '/api/deals/' + d.id, { stage_id: stage.Proposal }));
    const won = ok(await R('PATCH', '/api/deals/' + d.id, { stage_id: stage.Won }));
    assert.ok(won.closed_at); assert.equal(won.stage_kind, 'won');
    const det = ok(await R('GET', '/api/deals/' + d.id));
    assert.equal(det.timeline.filter(x => x.kind === 'stage').length, 3);
    assert.equal(ok(await R('GET', '/api/contacts/' + ids.peter)).lifecycle, 'customer');
    assert.equal(ok(await A('GET', '/api/deals?status=won')).total, 1);
    assert.equal(ok(await A('GET', '/api/deals?custom.contract_type=Annual')).total, 1);
    assert.equal(ok(await A('GET', '/api/deals?custom.contract_type=Monthly')).total, 0);
    assert.equal(ok(await A('GET', '/api/dashboard')).wonMonth.v, 12000);
    const lost = ok(await A('POST', '/api/deals', { title: 'Lost one', value: 500 }));
    ok(await A('PATCH', '/api/deals/' + lost.id, { stage_id: stage.Lost, lost_reason: 'Price' }));
  });
  await t('tenant isolation', async () => {
    assert.equal((await B('GET', '/api/deals/' + ids.deal)).s, 404);
    assert.equal((await B('PATCH', '/api/deals/' + ids.deal, { title: 'pwn' })).s, 404);
    assert.equal((await B('POST', '/api/deals', { title: 'x', contact_id: ids.peter })).s, 400);
    assert.equal((await B('POST', '/api/deals', { title: 'x', stage_id: stage.Won })).s, 400);
    assert.equal(ok(await B('GET', '/api/contacts')).total, 0);
    assert.equal(ok(await B('GET', '/api/search?q=Initech')).contacts.length, 0);
  });
  await t('search, saved views, bulk assign', async () => {
    const s = ok(await A('GET', '/api/search?q=initech')); assert.equal(s.companies.length, 1); assert.equal(s.deals.length, 1);
    ok(await A('POST', '/api/views', { entity: 'deals', name: 'Won deals', query: 'status=won' }));
    assert.equal(ok(await A('GET', '/api/views')).length, 1);
    const r = ok(await A('POST', '/api/contacts/bulk', { ids: [ids.annc], action: 'assign', value: ids.rita })); assert.equal(r.updated, 1);
    assert.equal(ok(await R('GET', '/api/contacts')).total, 2);
  });
  await t('CSV import (create + update + errors) and export', async () => {
    const csv = 'First,Last,Email,Company,Contract\nJane,Doe,jane@umbrella.com,Umbrella,\nJohn,Roe,peter@initech.com,Initech,\n,,,,\n"Quote, Inc",Person,bad-email,X,\n';
    const r1 = ok(await A('POST', '/api/import/contacts', { csv, mapping: { 0: 'first_name', 1: 'last_name', 2: 'email', 3: 'company' }, mode: 'skip' }));
    assert.equal(r1.created, 1); assert.equal(r1.skipped, 1); assert.equal(r1.errors.length, 1);
    const r2 = ok(await A('POST', '/api/import/contacts', { csv: 'email,title\npeter@initech.com,CTO\n', mapping: { 0: 'email', 1: 'title' }, mode: 'update' }));
    assert.equal(r2.updated, 1); assert.equal(ok(await A('GET', '/api/contacts/' + ids.peter)).title, 'CTO');
    const d = ok(await A('POST', '/api/import/deals', { csv: 'Name,Amount,Stage\nBig one,"$5,000",Qualified\n', mapping: { 0: 'title', 1: 'value', 2: 'stage' } }));
    assert.equal(d.created, 1);
    const ex = await A('GET', '/api/export/contacts'); assert.equal(ex.s, 200); assert.match(ex.j, /^id,name,email/); assert.match(ex.j, /jane@umbrella.com/); assert.match(ex.h.get('content-type'), /text\/csv/);
  });
  await t('duplicates + merge', async () => {
    const x = ok(await A('POST', '/api/contacts', { name: 'Jane Doe', company_id: ok(await A('GET', '/api/contacts?q=jane@umbrella')).rows[0].company_id }));
    const groups = ok(await A('GET', '/api/duplicates/contacts')); assert.ok(groups.some(g => g.records.some(r => r.id === x.id)));
    const keep = ok(await A('GET', '/api/contacts?q=jane@umbrella')).rows[0];
    ok(await A('POST', '/api/merge/contacts', { keep_id: keep.id, merge_ids: [x.id] }));
    assert.equal((await A('GET', '/api/contacts/' + x.id)).s, 404);
  });
  await t('tasks: overdue filter, complete → event', async () => {
    const a = ok(await R('POST', '/api/activities', { type: 'call', subject: 'Call Peter', contact_id: ids.peter, due_date: '2020-01-01' }));
    assert.equal(ok(await R('GET', '/api/activities?due=overdue')).total, 1);
    ok(await R('PATCH', '/api/activities/' + a.id, { done: true }));
    assert.equal(ok(await R('GET', '/api/activities?due=overdue')).total, 0);
    assert.equal((await R('POST', '/api/activities', { type: 'bogus', note: 'x' })).s, 400);
  });
  await t('email: templates with merge fields, send, open tracking, unsubscribe', async () => {
    const tpl = ok(await R('POST', '/api/templates', { name: 'Intro', subject: 'Hi {{contact.first_name}}', body: 'Hello {{contact.first_name}} at {{company.name}} — {{user.name}}' }));
    ids.tpl = tpl.id;
    const { id } = ok(await R('POST', '/api/emails/send', { contact_id: ids.peter, template_id: tpl.id })); await worker.runJobs();
    const e = ok(await R('GET', '/api/emails/' + id)); assert.equal(e.subject, 'Hi Peter'); assert.equal(e.body, 'Hello Peter at Initech — Rita Rep'); assert.equal(e.status, 'logged');
    const px = await fetch(`${base}/t/${e.track_token}.gif`); assert.equal(px.headers.get('content-type'), 'image/gif');
    assert.equal(ok(await R('GET', '/api/emails/' + id)).open_count, 1);
    const tl = ok(await R('GET', '/api/contacts/' + ids.peter)).timeline; assert.ok(tl.some(x => x.kind === 'email'));
  });
  await t('sequences: steps run, inbound reply stops enrollment, unsubscribe stops sending', async () => {
    const s = ok(await R('POST', '/api/sequences', { name: 'Nurture', steps: [{ type: 'email', template_id: ids.tpl, delay_days: 0 }, { type: 'task', note: 'Call them', delay_days: 1 }, { type: 'email', template_id: ids.tpl, delay_days: 1e6 }] }));
    const jane = ok(await A('GET', '/api/contacts?q=jane@umbrella')).rows[0];
    ok(await A('POST', `/api/sequences/${s.id}/enroll`, { contact_ids: [jane.id, ids.peter] }));
    assert.equal(ok(await A('POST', `/api/sequences/${s.id}/enroll`, { contact_ids: [jane.id] })).errors.length, 1, 'no double enrollment');
    await worker.tick(); await sleep(5); await worker.tick();
    const en = ok(await A('GET', `/api/sequences/${s.id}/enrollments`));
    assert.ok(en.every(e => e.step === 2 && e.status === 'active'), JSON.stringify(en.map(e => [e.step, e.status])));
    assert.ok(ok(await A('GET', '/api/activities?q=Call them')).total >= 2, 'task steps created');
    // Peter replies via inbound webhook → his enrollment stops
    const org = ok(await A('GET', '/api/me')).org; const token = org.inbound_url.split('/').pop();
    ok(await fetch(`${base}/api/inbound/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ From: 'Peter <peter@initech.com>', To: 'rita@acme.com', Subject: 'Re: Hi', TextBody: 'Sounds good', MessageID: 'm1' }) }).then(r => ({ s: r.status, j: null })));
    const en2 = ok(await A('GET', `/api/sequences/${s.id}/enrollments`)); assert.equal(en2.find(e => e.contact_id === ids.peter).status, 'replied');
    // Jane unsubscribes via link in a sequence email
    const mail = ok(await A('GET', '/api/emails')).find(e => e.contact_id === jane.id); const full = ok(await A('GET', '/api/emails/' + mail.id));
    await fetch(`${base}/u/${full.track_token}`, { method: 'POST' });
    assert.equal(ok(await A('GET', '/api/contacts/' + jane.id)).unsubscribed, 1);
    assert.equal(ok(await A('GET', `/api/sequences/${s.id}/enrollments`)).find(e => e.contact_id === jane.id).status, 'unsubscribed');
    assert.equal((await A('POST', '/api/emails/send', { contact_id: jane.id, subject: 'x', body: 'y' })).s, 400);
  });
  await t('workflows: deal.won creates task and notifies owner; condition respected', async () => {
    ok(await A('POST', '/api/workflows', { name: 'Won → onboarding', trigger: 'deal.won', conditions: [{ field: 'deal.value', op: 'gt', value: '1000' }],
      actions: [{ type: 'create_task', note: 'Kick off onboarding for {{deal.title}}', due_in_days: 1, assign: 'owner' }, { type: 'notify', to: 'manager', text: '{{owner.name}} won {{deal.title}}' }] }));
    assert.equal((await A('POST', '/api/workflows', { name: 'bad', trigger: 'nope', actions: [{ type: 'notify' }] })).s, 400);
    const small = ok(await R('POST', '/api/deals', { title: 'Small', value: 50 })), big = ok(await R('POST', '/api/deals', { title: 'Big', value: 5000 }));
    ok(await R('PATCH', '/api/deals/' + small.id, { stage_id: stage.Won })); ok(await R('PATCH', '/api/deals/' + big.id, { stage_id: stage.Won })); await sleep(30);
    const tasks = ok(await R('GET', '/api/activities?q=onboarding')).rows; assert.equal(tasks.length, 1); assert.equal(tasks[0].note, 'Kick off onboarding for Big');
    assert.ok(ok(await M('GET', '/api/notifications')).some(n => n.text === 'Rita Rep won Big'));
  });
  await t('webhooks: signed delivery on events', async () => {
    const w = ok(await A('POST', '/api/webhooks', { url: hookUrl, events: ['deal.created'] }));
    ok(await A('POST', '/api/deals', { title: 'Hooked deal', value: 1 })); await worker.runJobs(); await sleep(20);
    const got = received.find(x => JSON.parse(x.body).event === 'deal.created'); assert.ok(got, 'delivered');
    const sig = crypto.createHmac('sha256', w.secret).update(got.body).digest('hex'); assert.equal(got.headers['x-pipelinehq-signature'], 'sha256=' + sig);
  });
  await t('lead forms: hosted page, submission creates assigned lead, honeypot', async () => {
    const f = ok(await A('POST', '/api/forms', { name: 'Demo request', fields: ['name', 'email', 'company', 'message'], assign_mode: 'round_robin' }));
    const page = await fetch(`${base}/f/${f.key}`); assert.equal(page.status, 200); assert.match(await page.text(), /Demo request/);
    const r = await fetch(`${base}/f/${f.key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Lead Lee', email: 'lee@hooli.com', company: 'Hooli', message: 'Need a demo' }) });
    assert.equal(r.status, 200);
    const lead = ok(await A('GET', '/api/contacts?q=lee@hooli.com')).rows[0]; assert.ok(lead.owner_id); assert.equal(lead.source, 'form: Demo request'); assert.equal(lead.company_name, 'Hooli');
    const html = await fetch(`${base}/f/${f.key}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=Bot&email=bot@spam.com&_hp=gotcha' });
    assert.equal(html.status, 200); assert.equal(ok(await A('GET', '/api/contacts?q=bot@spam.com')).total, 0);
  });
  await t('booking pages: slots, booking creates meeting, double-booking blocked, ICS feed', async () => {
    ok(await R('POST', '/api/booking-pages', { slug: 'rita-demo', title: 'Product demo', duration_min: 30, days: '0,1,2,3,4,5,6', start_hour: 0, end_hour: 24, timezone: 'America/New_York' }));
    const days = await (await fetch(`${base}/book/rita-demo/slots`)).json(); assert.ok(days.length >= 13); const slot = days[1].slots[3];
    const b = await fetch(`${base}/book/rita-demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Booker Bee', email: 'bee@hive.com', start: slot }) });
    assert.equal(b.status, 200, await b.clone().text());
    const again = await fetch(`${base}/book/rita-demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X', email: 'x@y.com', start: slot }) });
    assert.equal(again.status, 409);
    const mt = ok(await R('GET', '/api/activities?type=meeting')).rows[0]; assert.equal(mt.start_at, slot.replace('T', ' ').slice(0, 19));
    const meR = ok(await R('GET', '/api/me')); const ics = await (await fetch(`${base}/cal/${meR.user.calendar_token}.ics`)).text();
    assert.match(ics, /BEGIN:VCALENDAR/); assert.match(ics, /Product demo with Booker Bee/);
  });
  await t('products, price books, quotes, public e-signature accept', async () => {
    const p = ok(await A('POST', '/api/products', { name: 'Seat license', sku: 'SEAT', price: 100 }));
    const pb = ok(await A('POST', '/api/price-books', { name: 'Partner' })); ok(await A('PUT', `/api/price-books/${pb.id}/entries`, { entries: [{ product_id: p.id, price: 80 }] }));
    const deal = ok(await A('POST', '/api/deals', { title: 'Quote deal', contact_id: ids.peter, value: 1000 }));
    let qt = ok(await A('POST', '/api/quotes', { deal_id: deal.id, price_book_id: pb.id }));
    qt = ok(await A('PUT', `/api/quotes/${qt.id}/items`, { items: [{ product_id: p.id, qty: 10 }, { name: 'Onboarding', qty: 1, unit_price: 500, discount_pct: 10 }] }));
    qt = ok(await A('PATCH', `/api/quotes/${qt.id}`, { discount_pct: 5, tax_pct: 10 }));
    assert.equal(qt.subtotal, 1250); assert.equal(qt.discount, 62.5); assert.equal(qt.tax, 118.75); assert.equal(qt.total, 1306.25);
    ok(await A('POST', `/api/quotes/${qt.id}/send`, {}));
    const token = qt.public_url.split('/').pop();
    const view = await fetch(`${base}/q/${token}`); assert.match(await view.text(), /Seat license/);
    const acc = await fetch(`${base}/q/${token}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=Peter+Gibbons&agree=on', redirect: 'manual' });
    assert.equal(acc.status, 303);
    const after = ok(await A('GET', `/api/quotes/${qt.id}`)); assert.equal(after.status, 'accepted'); assert.equal(after.signed_name, 'Peter Gibbons');
    assert.equal((await A('PUT', `/api/quotes/${qt.id}/items`, { items: [] })).s, 400, 'accepted quote is locked');
  });
  await t('quotas, forecast, reports', async () => {
    const period = new Date().toISOString().slice(0, 7);
    ok(await A('PUT', '/api/quotas', { user_id: ids.rita, period, amount: 20000 }));
    assert.equal((await R('PUT', '/api/quotas', { user_id: ids.rita, period, amount: 1 })).s, 403);
    const f = ok(await A('GET', '/api/forecast')); const rita = f.reps.find(r => r.user_id === ids.rita);
    assert.equal(rita.won, 17050); assert.equal(rita.quota, 20000); assert.equal(rita.attainment, 85); assert.equal(f.series.length, 6);
    const rep = ok(await A('GET', '/api/reports'));
    assert.ok(rep.funnel.length >= 4); assert.equal(rep.summary.won, 3); assert.equal(rep.summary.lost, 1); assert.equal(rep.summary.win_rate, 75);
    assert.equal(rep.lost_reasons[0].reason, 'Price'); assert.ok(rep.leaderboard.length >= 3);
    assert.equal(ok(await R('GET', '/api/reports')).leaderboard.length, 1, 'rep sees only self');
  });
  await t('pipelines: second pipeline, stage editing guards', async () => {
    const p = ok(await A('POST', '/api/pipelines', { name: 'Renewals' }));
    const st = ok(await A('GET', '/api/pipelines')).find(x => x.id === p.id).stages;
    ok(await A('PUT', `/api/pipelines/${p.id}/stages`, { stages: [...st.slice(0, 2), ...st.slice(4)].map(s => ({ ...s, name: s.name === 'Lead' ? 'Upcoming' : s.name })) }));
    assert.equal((await A('PUT', `/api/pipelines/${pipeline.id}/stages`, { stages: pipeline.stages.filter(s => s.name !== 'Won') })).s, 400);
    assert.equal((await A('PUT', `/api/pipelines/${pipeline.id}/stages`, { stages: pipeline.stages.filter(s => s.name !== 'Proposal') })).s, 200, 'empty stage removable');
  });
  await t('files: upload, download, scoped', async () => {
    const up = ok(await R('POST', `/api/files?entity=deals&id=${ids.deal}`, undefined, { raw: Buffer.from('hello pdf'), headers: { 'Content-Type': 'application/json', 'X-Filename': 'proposal.pdf' } }));
    const dl = await R('GET', '/api/files/' + up.id); assert.equal(dl.j, 'hello pdf'); assert.match(dl.h.get('content-disposition'), /attachment/);
    assert.equal((await B('GET', '/api/files/' + up.id)).s, 404);
  });
  await t('2FA (TOTP) enforced at login', async () => {
    const s = ok(await M('POST', '/api/2fa/setup'));
    assert.equal((await M('POST', '/api/2fa/enable', { code: '000000' })).s, 400);
    ok(await M('POST', '/api/2fa/enable', { code: totpAt(s.secret, Math.floor(Date.now() / 30000)) }));
    const X = client(); const l = ok(await X('POST', '/api/login', { email: 'max@acme.com', password: 'password123' }));
    assert.equal(l.need_2fa, true); assert.equal((await X('GET', '/api/me')).s, 401);
    assert.equal((await X('POST', '/api/login/2fa', { ticket: l.ticket, code: '123456' })).s, 401);
    ok(await X('POST', '/api/login/2fa', { ticket: l.ticket, code: totpAt(s.secret, Math.floor(Date.now() / 30000)) }));
    assert.equal(ok(await X('GET', '/api/me')).user.email, 'max@acme.com');
  });
  await t('password reset + login throttling', async () => {
    const f = ok(await client()('POST', '/api/forgot', { email: 'rita@acme.com' })); assert.ok(f.dev_link);
    assert.ok(!ok(await client()('POST', '/api/forgot', { email: 'nobody@x.com' })).dev_link, 'no account enumeration');
    const X = client(); ok(await X('POST', '/api/reset', { token: new URL(f.dev_link.replace('/#/', '/')).searchParams.get('token'), password: 'newpassword1' }));
    assert.equal(ok(await X('GET', '/api/me')).user.email, 'rita@acme.com');
    assert.equal((await R('GET', '/api/me')).s, 401, 'old sessions revoked');
    ok(await R('POST', '/api/login', { email: 'rita@acme.com', password: 'newpassword1' }));
    const Y = client(); let last; for (let i = 0; i < 9; i++) last = await Y('POST', '/api/login', { email: 'ann@acme.com', password: 'wrong' }); assert.equal(last.s, 429);
  });
  await t('CSRF: cross-origin and non-JSON writes are rejected', async () => {
    assert.equal((await A('POST', '/api/contacts', { name: 'x' }, { headers: { Origin: 'https://evil.example' } })).s, 403);
    assert.equal((await A('POST', '/api/contacts', undefined, { raw: 'name=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).s, 415);
  });
  await t('API keys: bearer auth, scoped to org, revocable', async () => {
    const { key } = ok(await A('POST', '/api/api-keys', { name: 'Zapier' }));
    const r = await fetch(`${base}/api/deals?status=won`, { headers: { Authorization: 'Bearer ' + key } }); assert.equal(r.status, 200); assert.ok((await r.json()).total >= 1);
    const c = await fetch(`${base}/api/contacts`, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Via API' }) }); assert.equal(c.status, 200);
    assert.equal((await fetch(`${base}/api/deals`, { headers: { Authorization: 'Bearer crm_nope' } })).status, 401);
  });
  await t('audit log, GDPR export, contact erasure', async () => {
    const log = ok(await A('GET', '/api/audit')); assert.ok(log.some(a => a.action === 'update' && a.entity === 'deal'));
    assert.equal((await R('GET', '/api/audit')).s, 403);
    const ex = await A('GET', '/api/org/export'); assert.equal(ex.s, 200); assert.ok(ex.j.contacts.length >= 3 && ex.j.deals.length >= 3);
    const victim = ok(await A('POST', '/api/contacts', { name: 'Erase Me', email: 'erase@me.com' }));
    ok(await A('POST', '/api/activities', { note: 'secret note', contact_id: victim.id }));
    ok(await A('DELETE', `/api/contacts/${victim.id}?erase=1`));
    assert.equal(ok(await A('GET', '/api/activities?q=secret')).total, 0);
  });
  await t('AI endpoints report not-configured cleanly; enrichment requires a site', async () => {
    const r = await A('POST', '/api/ai/draft-email', { contact_id: ids.peter }); assert.equal(r.s, 501);
    const bare = ok(await A('POST', '/api/companies', { name: 'No Site LLC' }));
    assert.equal((await A('POST', `/api/companies/${bare.id}/enrich`)).s, 400);
  });
  await t('billing: downgrade to Free enforces seats and Pro features', async () => {
    ok(await A('POST', '/api/billing/portal')); // dev mode → free
    const me2 = ok(await A('GET', '/api/me')); assert.equal(me2.plan.plan, 'free');
    assert.equal((await A('POST', '/api/team/invite', { email: 'fourth@acme.com' })).s, 402);
    assert.equal((await A('GET', '/api/workflows')).s, 402);
    assert.equal((await A('POST', '/api/pipelines', { name: 'Third' })).s, 402);
    ok(await A('POST', '/api/billing/checkout', { seats: 5 }));
    assert.equal(ok(await A('GET', '/api/me')).plan.plan, 'pro');
  });
  await t('super-admin: list orgs, impersonate and stop', async () => {
    const orgs = ok(await A('GET', '/api/sa/orgs')); assert.ok(orgs.length >= 2);
    assert.equal((await B('GET', '/api/sa/orgs')).s, 403);
    ok(await A('POST', '/api/sa/impersonate', { org_id: orgs.find(o => o.name === 'Globex').id }));
    const asBob = ok(await A('GET', '/api/me')); assert.equal(asBob.user.email, 'bob@globex.com'); assert.equal(asBob.impersonating.email, 'ann@acme.com');
    ok(await A('POST', '/api/sa/stop')); assert.equal(ok(await A('GET', '/api/me')).user.email, 'ann@acme.com');
  });
  await t('deactivate user reassigns records and revokes access', async () => {
    ok(await A('PATCH', '/api/team/' + ids.rita, { active: false, reassign_to: ids.max }));
    assert.equal((await R('GET', '/api/me')).s, 401);
    assert.equal(ok(await A('GET', '/api/contacts/' + ids.peter)).owner_id, ids.max);
  });
  await t('workspace deletion removes all tenant data', async () => {
    assert.equal((await B('POST', '/api/org/delete', { password: 'wrong' })).s, 403);
    ok(await B('POST', '/api/org/delete', { password: 'password123' }));
    assert.equal((await B('GET', '/api/me')).s, 401);
    const X = client(); assert.equal((await X('POST', '/api/login', { email: 'bob@globex.com', password: 'password123' })).s, 401);
  });
  await t('static SPA + security headers', async () => {
    const r = await fetch(base + '/'); assert.equal(r.status, 200); assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(base + '/../server.js')).status, 404);
  });

  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${results.length - passed} failed`);
  hook.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); setTimeout(() => process.exit(), 50);
});
