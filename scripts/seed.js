// Seed a demo workspace through the public API.  Usage: node scripts/seed.js [http://localhost:3000]
// Creates demo@pipelinehq.test / demo12345 with realistic companies, contacts, deals, tasks, templates, a sequence, a form, a booking page and automations.
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
let cookie = '';
async function api(method, path, body) {
  const r = await fetch(base + '/api/' + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie?.() || []; for (const c of sc) if (c.startsWith('sid=') && !/Max-Age=0/.test(c)) cookie = c.split(';')[0];
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path}: ${j.error || r.status}`); return j;
}
const pick = a => a[Math.floor(Math.random() * a.length)];
const daysFrom = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  try { await api('POST', 'signup', { org: 'Northwind Software', name: 'Dana Demo', email: 'demo@pipelinehq.test', password: 'demo12345' }); }
  catch { await api('POST', 'login', { email: 'demo@pipelinehq.test', password: 'demo12345' }); }
  const me = await api('GET', 'me');
  const stages = me.pipelines[0].stages, S = Object.fromEntries(stages.map(s => [s.name, s.id]));
  const users = [me.user.id];
  for (const [email, name, role] of [['sam@pipelinehq.test', 'Sam Seller', 'rep'], ['mia@pipelinehq.test', 'Mia Manager', 'manager']]) {
    try {
      const inv = await api('POST', 'team/invite', { email, role });
      if (inv.dev_link) {
        const token = new URL(inv.dev_link.replace('/#/', '/')).searchParams.get('token'); const keep = cookie;
        await api('POST', 'invite/accept', { token, name, password: 'demo12345' }); cookie = keep;
      }
    } catch (e) { if (!/already/.test(e.message)) console.warn(e.message); }
  }
  const team = await api('GET', 'team'); users.push(...team.filter(u => u.id !== me.user.id).map(u => u.id));
  const mia = team.find(u => u.email === 'mia@pipelinehq.test'), sam = team.find(u => u.email === 'sam@pipelinehq.test');
  if (mia && sam) await api('PATCH', 'team/' + sam.id, { manager_id: mia.id });

  await api('POST', 'fields', { entity: 'deals', label: 'Contract type', type: 'select', options: ['Annual', 'Monthly', 'Multi-year'] }).catch(() => { });
  await api('POST', 'fields', { entity: 'contacts', label: 'LinkedIn', type: 'url' }).catch(() => { });

  const COMPANIES = [['Acme Logistics', 'acmelogistics.example', 'Logistics', '201-1000'], ['Brightline Health', 'brightline.example', 'Healthcare', '51-200'], ['Cobalt Robotics', 'cobalt.example', 'Manufacturing', '201-1000'],
    ['Delta Foods', 'deltafoods.example', 'Food & Beverage', '1000+'], ['Evergreen Bank', 'evergreen.example', 'Financial services', '1000+'], ['Fable Studio', 'fable.example', 'Media', '11-50'],
    ['Granite Insurance', 'granite.example', 'Insurance', '201-1000'], ['Harbor Retail', 'harbor.example', 'Retail', '51-200'], ['Ion Energy', 'ion.example', 'Energy', '51-200'], ['Juniper Labs', 'juniper.example', 'Biotech', '11-50']];
  const FIRST = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Quinn', 'Rowan', 'Sasha', 'Drew'], LAST = ['Nguyen', 'Patel', 'Garcia', 'Kim', 'Okafor', 'Silva', 'Novak', 'Haddad', 'Larsen', 'Moreau'];
  const TITLES = ['VP Sales', 'Head of Operations', 'CTO', 'Procurement Manager', 'Director of IT', 'COO', 'Founder & CEO', 'RevOps Lead'];
  const contacts = [];
  for (const [name, domain, industry, size] of COMPANIES) {
    const co = await api('POST', 'companies', { name, website: domain, industry, size, owner_id: pick(users), force: true });
    for (let i = 0; i < 2; i++) {
      const f = pick(FIRST), l = pick(LAST);
      contacts.push(await api('POST', 'contacts', { name: `${f} ${l}`, email: `${f}.${l}${i}@${domain}`.toLowerCase(), phone: '+1415555' + String(1000 + contacts.length).slice(-4), title: pick(TITLES), company_id: co.id, owner_id: co.owner_id, lifecycle: pick(['lead', 'prospect', 'prospect']), source: pick(['Website', 'Referral', 'Outbound', 'Event', 'LinkedIn']), force: true }));
    }
  }
  const DEALS = ['Platform license', 'Expansion', 'Pilot', 'Annual renewal', 'Add-on seats', 'Integration package'];
  const plan = [['Lead', 0], ['Lead', 0], ['Qualified', 0], ['Qualified', 0], ['Qualified', 0], ['Proposal', 0], ['Proposal', 0], ['Negotiation', 0], ['Negotiation', 0], ['Won', 0], ['Won', 0], ['Won', 0], ['Won', 0], ['Lost', 'Price'], ['Lost', 'Competitor'], ['Lost', 'Timing'], ['Proposal', 0], ['Lead', 0]];
  for (const [i, [stage, reason]] of plan.entries()) {
    const c = contacts[i % contacts.length];
    const d = await api('POST', 'deals', { title: `${COMPANIES[i % COMPANIES.length][0].split(' ')[0]} — ${pick(DEALS)}`, value: Math.round((3 + Math.random() * 60)) * 500, contact_id: c.id, owner_id: c.owner_id,
      close_date: daysFrom(Math.round(Math.random() * 120) - 20), custom: { contract_type: pick(['Annual', 'Monthly', 'Multi-year']) } });
    const path = ['Qualified', 'Proposal', 'Negotiation'];
    for (const st of path) { if (stage === 'Lead' || (stages.find(s => s.name === stage).kind === 'open' && path.indexOf(st) >= path.indexOf(stage) + 1)) break; await api('PATCH', 'deals/' + d.id, { stage_id: S[st] }); if (st === stage) break; }
    if (stage === 'Won' || stage === 'Lost') await api('PATCH', 'deals/' + d.id, { stage_id: S[stage], lost_reason: reason || undefined });
  }
  for (const [i, c] of contacts.slice(0, 8).entries()) {
    await api('POST', 'activities', { type: pick(['task', 'call', 'task']), subject: pick(['Send pricing', 'Follow up on demo', 'Book discovery call', 'Share case study']), contact_id: c.id, owner_id: c.owner_id, due_date: daysFrom(i - 3) });
    await api('POST', 'activities', { type: 'note', note: pick(['Interested in API access and SSO.', 'Budget approved for Q3.', 'Evaluating two other vendors.', 'Wants a security review before signing.']), contact_id: c.id, done: true });
  }
  await api('POST', 'activities', { type: 'meeting', subject: 'Discovery call', contact_id: contacts[0].id, start_at: new Date(Date.now() + 26 * 3600e3).toISOString(), duration_min: 30 });
  const period = new Date().toISOString().slice(0, 7);
  for (const u of users) await api('PUT', 'quotas', { user_id: u, period, amount: 60000 });
  const t1 = await api('POST', 'templates', { name: 'Intro', subject: 'Quick idea for {{company.name}}', body: 'Hi {{contact.first_name}},\n\nTeams like {{company.name}} use us to cut sales admin in half. Worth a 15-minute look next week?\n\nBest,\n{{user.name}}' });
  const t2 = await api('POST', 'templates', { name: 'Follow-up', subject: 'Re: Quick idea for {{company.name}}', body: 'Hi {{contact.first_name}}, bumping this up in case it got buried — happy to send a 2-minute video instead.\n\n{{user.name}}' });
  await api('POST', 'sequences', { name: 'Outbound — 3 touch', steps: [{ type: 'email', template_id: t1.id, delay_days: 0 }, { type: 'task', note: 'Call and leave a voicemail', delay_days: 2 }, { type: 'email', template_id: t2.id, delay_days: 3 }] });
  await api('POST', 'forms', { name: 'Request a demo', fields: ['name', 'email', 'company', 'phone', 'message'], assign_mode: 'round_robin' });
  await api('POST', 'booking-pages', { slug: 'dana-demo-' + Math.random().toString(36).slice(2, 6), title: 'Product demo', duration_min: 30, timezone: 'America/New_York' });
  await api('POST', 'products', { name: 'Pro seat (annual)', sku: 'PRO-Y', price: 348 }); await api('POST', 'products', { name: 'Onboarding package', sku: 'ONB', price: 1500 });
  await api('POST', 'workflows', { name: 'Won → onboarding task', trigger: 'deal.won', conditions: [], actions: [{ type: 'create_task', note: 'Kick off onboarding for {{deal.title}}', due_in_days: 2, assign: 'owner' }, { type: 'notify', to: 'manager', text: '🎉 {{owner.name}} won {{deal.title}}' }] });
  console.log(`Seeded. Sign in at ${base} as demo@pipelinehq.test / demo12345 (teammates: sam@ / mia@pipelinehq.test, same password).`);
})().catch(e => { console.error(e.message); process.exit(1); });
