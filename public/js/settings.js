/* Settings (profile, security, organization, team, pipelines, custom fields, integrations, billing, audit, data) and super-admin console. */
'use strict';

route(/^\/settings(?:\/(\w+))?$/, async (main, m, query) => {
  const tab = m[1] || 'profile', admin = can.admin(), owner = ME.user.role === 'owner';
  const TABS = [['profile', 'Profile & email'], ['security', 'Security'], ...(admin ? [['org', 'Organization'], ['team', 'Team'], ['pipelines', 'Pipelines'], ['fields', 'Custom fields'], ['integrations', 'API & integrations'], ['audit', 'Audit log']] : [['integrations', 'API keys']]),
    ...(owner ? [['billing', 'Billing'], ['data', 'Data & privacy']] : [])];
  const head = `<div class="ph"><h2>Settings</h2></div>${tabsHtml(TABS.map(([k, l]) => [k, l, '#/settings/' + k]), tab)}`;
  const P = SettingsTabs[tab]; if (!P) { main.innerHTML = head + '<div class="empty">Not available.</div>'; return; }
  main.innerHTML = head + '<div id="st"></div>';
  await P($('#st', main), query);
});

const SettingsTabs = {
  async profile(el, query) {
    if (query.get('gmail')) { toast('Gmail connected'); await refreshMe(); }
    el.innerHTML = `<div class="cols"><div class="card"><h3>Your profile</h3><form id="pf">${fieldHtml({ k: 'name', l: 'Name', req: 1 }, ME.user.name)}${fieldHtml({ k: 'phone', l: 'Phone (E.164, used for click-to-call)', ph: '+14155550123' }, ME.user.phone)}
      ${fieldHtml({ k: 'notify_email', l: 'Email me about assignments, replies and overdue tasks', t: 'checkbox' }, ME.user.notify_email)}<div class="err"></div><button class="btn mt">Save</button></form></div>
      <div class="card"><h3>Email sync</h3>${ME.features.google ? (ME.user.gmail_connected
        ? `<p>✅ Connected to <b>${esc(ME.user.google_email)}</b>. Emails you send from the CRM go out from Gmail, and messages to/from your contacts are logged automatically every few minutes.</p><button class="btn ghost" id="gs">Sync now</button> <button class="btn ghost" id="gd">Disconnect</button>`
        : '<p class="muted">Connect Gmail to send from your own address and automatically log emails with contacts.</p><a class="btn" href="/auth/google/start?mode=connect">Connect Gmail</a>')
        : '<p class="muted small">Gmail sync is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).</p>'}
      <h4 class="mt">Log emails from any mailbox</h4><p class="small muted">BCC or forward emails to this address and they're logged to the matching contact:</p><pre class="code">${esc(ME.org.inbound_address)}</pre>
      <p class="small muted">Configure your inbound-email provider (Postmark, Mailgun…) to POST to:</p><pre class="code">${esc(ME.org.inbound_url)}</pre></div>
      <div class="card"><h3>Change password</h3><form id="pw">${fieldHtml({ k: 'current_password', l: 'Current password', t: 'password' })}${fieldHtml({ k: 'new_password', l: 'New password', t: 'password', req: 1, attrs: 'minlength="8" autocomplete="new-password"' })}<div class="err"></div><button class="btn mt">Update password</button></form></div></div>`;
    $('#pf', el).onsubmit = async e => { e.preventDefault(); try { await api('PATCH', 'me', readForm(e.target, [{ k: 'name' }, { k: 'phone' }, { k: 'notify_email', t: 'checkbox' }])); await refreshMe(); toast('Saved'); render(); } catch (x) { $('.err', e.target).textContent = x.message; } };
    $('#pw', el).onsubmit = async e => { e.preventDefault(); if (!e.target.reportValidity()) return; try { await api('PATCH', 'me', readForm(e.target, [{ k: 'current_password' }, { k: 'new_password' }])); toast('Password updated — other sessions signed out'); e.target.reset(); } catch (x) { $('.err', e.target).textContent = x.message; } };
    $('#gs', el)?.addEventListener('click', async () => { try { const r = await api('POST', 'google/sync'); toast(`${r.logged} emails logged`); } catch (x) { fail(x); } });
    $('#gd', el)?.addEventListener('click', async () => { await api('POST', 'google/disconnect'); await refreshMe(); render(); });
  },
  async security(el) {
    el.innerHTML = `<div class="cols"><div class="card"><h3>Two-factor authentication</h3>${ME.user.totp_enabled ? `<p>✅ 2FA is on. You'll be asked for a code from your authenticator app at sign-in.</p><button class="btn ghost" id="off">Turn off 2FA</button>`
      : '<p class="muted">Protect your account with a code from an authenticator app (Google Authenticator, 1Password, Authy…).</p><button class="btn" id="on">Set up 2FA</button>'}<div id="tf"></div></div>
      <div class="card"><h3>Sessions</h3><p class="muted">Sign out everywhere, including other browsers and devices.</p><button class="btn ghost" id="all">Sign out all sessions</button></div></div>`;
    $('#on', el)?.addEventListener('click', async () => {
      const s = await api('POST', '2fa/setup');
      $('#tf', el).innerHTML = `<ol class="small"><li>In your authenticator app, add an account and enter this key manually (time-based):</li></ol><pre class="code">${esc(s.secret.replace(/(.{4})/g, '$1 ').trim())}</pre>
        <p class="small muted">Or on mobile, <a href="${esc(s.otpauth)}">open in authenticator app</a>.</p><label class="f">Enter the 6-digit code to confirm</label><div class="row"><input id="code" inputmode="numeric" maxlength="8" style="width:140px"><button class="btn" id="vf">Verify & enable</button></div><div class="err"></div>`;
      $('#vf', el).onclick = async () => { try { await api('POST', '2fa/enable', { code: $('#code', el).value }); await refreshMe(); toast('2FA enabled'); render(); } catch (x) { $('.err', el).textContent = x.message; } };
    });
    $('#off', el)?.addEventListener('click', () => formModal({ title: 'Turn off 2FA', fields: [{ k: 'password', l: 'Password', t: 'password' }, { k: 'code', l: 'Current 6-digit code', req: 1 }], submit: v => api('POST', '2fa/disable', v), after: async () => { await refreshMe(); toast('2FA turned off'); render(); } }));
    $('#all', el).onclick = async () => { await api('POST', 'logout-all'); ME = null; $('#root').innerHTML = ''; go('#/login'); };
  },
  async org(el) {
    const o = await api('GET', 'org');
    const fields = [{ k: 'name', l: 'Company name', req: 1 }, { k: 'currency', l: 'Currency (ISO code)', req: 1, ph: 'USD' }, { k: 'timezone', l: 'Time zone (IANA)', req: 1, ph: 'America/New_York' },
      { k: 'stall_days', l: 'Flag deals as stalled after N days without a stage change', t: 'number', req: 1 }, { k: 'lost_reasons', l: 'Lost reasons (one per line)', t: 'textarea', rows: 6 }];
    el.innerHTML = `<div class="card" style="max-width:560px"><form id="of">${fields.map(f => fieldHtml(f, f.k === 'lost_reasons' ? o.lost_reasons.join('\n') : o[f.k])).join('')}<div class="err"></div><button class="btn mt">Save</button></form></div>`;
    $('#of', el).onsubmit = async e => { e.preventDefault(); const v = readForm(e.target, fields); v.lost_reasons = v.lost_reasons.split('\n').map(s => s.trim()).filter(Boolean); v.currency = v.currency.toUpperCase();
      try { await api('PATCH', 'org', v); await refreshMe(); toast('Saved'); render(); } catch (x) { $('.err', e.target).textContent = x.message; } };
  },
  async team(el) {
    const [team, invites] = await Promise.all([api('GET', 'team'), api('GET', 'team/invites')]);
    const ROLE = { owner: 'Owner — everything incl. billing', admin: 'Admin — all data & settings', manager: 'Manager — own + team’s records', rep: 'Rep — own records' };
    el.innerHTML = `<div class="row mb"><span class="grow small muted">Roles control what people see. Managers see records owned by people who report to them. ${ME.plan.users ? `Seats: ${team.filter(u => u.active).length + invites.length} / ${ME.plan.users}` : ''}</span><button class="btn" id="inv">＋ Invite</button></div>
      ${table({ rows: team, cols: [{ l: 'Name', f: u => `<b>${esc(u.name)}</b>${u.active ? '' : ' <span class="tag gray">deactivated</span>'}${u.totp_enabled ? ' <span class="tag ok" data-tip="2FA enabled">2FA</span>' : ''}<div class="small muted">${esc(u.email)}</div>` },
        { l: 'Role', f: u => u.role === 'owner' || u.id === ME.user.id ? `<span class="tag">${u.role}</span>` : `<select data-role="${u.id}" style="width:auto">${['admin', 'manager', 'rep', ...(ME.user.role === 'owner' ? ['owner'] : [])].map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>` },
        { l: 'Reports to', f: u => `<select data-mgr="${u.id}" style="width:auto"><option value="">—</option>${team.filter(x => x.id !== u.id && x.active && x.role !== 'rep').map(x => `<option value="${x.id}" ${u.manager_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` },
        { l: '', f: u => u.id === ME.user.id || u.role === 'owner' ? '' : `<button class="btn ghost sm" data-act="${u.id}">${u.active ? 'Deactivate' : 'Reactivate'}</button>` }] })}
      ${invites.length ? `<h3 class="mt mb">Pending invites</h3>${table({ rows: invites, cols: [{ l: 'Email', k: 'email' }, { l: 'Role', k: 'role' }, { l: 'Expires', f: i => fmt.date(new Date(i.expires).toISOString()) }, { l: '', f: i => `<button class="btn link small" data-rev="${i.id}">Revoke</button>` }] })}` : ''}
      <div class="card mt"><h4>Roles</h4>${Object.entries(ROLE).map(([k, v]) => `<div class="small" style="padding:2px 0"><b>${k}</b> — ${esc(v.split('— ')[1])}</div>`).join('')}</div>`;
    const patch = async (id, body) => { try { await api('PATCH', 'team/' + id, body); toast('Updated'); await refreshMe(); render(); } catch (x) { fail(x); render(); } };
    $$('[data-role]', el).forEach(s => s.onchange = async () => { if (s.value === 'owner' && !(await confirmBox('Transfer ownership? You will become an admin.', { ok: 'Transfer' }))) return render(); patch(s.dataset.role, { role: s.value }); });
    $$('[data-mgr]', el).forEach(s => s.onchange = () => patch(s.dataset.mgr, { manager_id: s.value || null }));
    $$('[data-rev]', el).forEach(b => b.onclick = async () => { await api('DELETE', 'team/invites/' + b.dataset.rev); render(); });
    $$('[data-act]', el).forEach(b => b.onclick = () => {
      const u = team.find(x => x.id === Number(b.dataset.act));
      if (!u.active) return patch(u.id, { active: true });
      formModal({ title: `Deactivate ${u.name}`, fields: [{ k: 'reassign_to', l: 'Reassign their contacts, deals and tasks to', t: 'select', opts: [['', 'Leave as is'], ...team.filter(x => x.active && x.id !== u.id).map(x => [x.id, x.name])] }], submitLabel: 'Deactivate',
        submit: v => api('PATCH', 'team/' + u.id, { active: false, reassign_to: v.reassign_to || undefined }), after: async () => { await refreshMe(); render(); } });
    });
    $('#inv', el).onclick = () => formModal({ title: 'Invite a teammate', values: { role: 'rep' }, fields: [{ k: 'email', l: 'Email', t: 'email', req: 1 }, { k: 'role', l: 'Role', t: 'select', opts: [['rep', 'Rep'], ['manager', 'Manager'], ['admin', 'Admin']] }, { k: 'manager_id', l: 'Reports to', t: 'select', opts: [['', '—'], ...team.filter(x => x.active && x.role !== 'rep').map(x => [x.id, x.name])] }],
      submitLabel: 'Send invite', submit: async v => { const r = await api('POST', 'team/invite', v); if (r.dev_link) { modal('Invite created', `<p>No mail provider is configured, so share this link with them:</p><pre class="code">${esc(r.dev_link)}</pre>`); } else toast('Invite sent'); }, after: () => render() });
  },
  async pipelines(el) {
    const ps = await api('GET', 'pipelines');
    el.innerHTML = `<div class="row mb"><span class="grow small muted">Each pipeline has its own stages. Probability drives weighted pipeline and forecast.</span><button class="btn" id="np">＋ Pipeline</button></div>
      ${ps.map(p => `<div class="card mb"><div class="row mb"><h3 class="grow">${esc(p.name)}</h3><button class="btn ghost sm" data-ren="${p.id}">Rename</button><button class="btn ghost sm" data-st="${p.id}">Edit stages</button>${ps.length > 1 ? `<button class="btn ghost sm" data-del="${p.id}">Delete</button>` : ''}</div>
        <div class="row">${p.stages.map(s => `${stageTag(s.name, s.kind)}<span class="small muted">${s.probability}%</span>`).join(' → ')}</div></div>`).join('')}`;
    $('#np', el).onclick = () => formModal({ title: 'New pipeline', fields: [{ k: 'name', l: 'Name', req: 1, ph: 'e.g. Renewals' }], submit: v => api('POST', 'pipelines', v), after: async () => { await refreshMe(); render(); } });
    $$('[data-ren]', el).forEach(b => b.onclick = () => { const p = ps.find(x => x.id === Number(b.dataset.ren)); formModal({ title: 'Rename pipeline', values: p, fields: [{ k: 'name', l: 'Name', req: 1 }], submit: v => api('PATCH', 'pipelines/' + p.id, v), after: async () => { await refreshMe(); render(); } }); });
    $$('[data-del]', el).forEach(b => b.onclick = async () => { if (await confirmBox('Delete this pipeline? It must have no deals.', { ok: 'Delete' })) { try { await api('DELETE', 'pipelines/' + b.dataset.del); await refreshMe(); render(); } catch (x) { fail(x); } } });
    $$('[data-st]', el).forEach(b => b.onclick = () => {
      const p = ps.find(x => x.id === Number(b.dataset.st)); let st = p.stages.map(s => ({ ...s }));
      const mm = modal('Stages — ' + p.name, '<div id="sl"></div><button class="btn ghost sm" id="add">＋ Stage</button><div class="err"></div><div class="mf"><span class="sp"></span><button class="btn" id="sv">Save stages</button></div>', { wide: true });
      const draw = () => {
        $('#sl', mm.el).innerHTML = st.map((s, i) => `<div class="rowed"><input data-i="${i}" data-k="name" value="${esc(s.name)}" aria-label="Stage name"><select data-i="${i}" data-k="kind">${['open', 'won', 'lost'].map(k => `<option ${s.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
          <label class="small row" style="gap:4px"><input type="number" min="0" max="100" data-i="${i}" data-k="probability" value="${s.probability}" style="width:70px"> %</label>
          <span class="row" style="gap:2px"><button class="btn link" data-up="${i}" aria-label="Move up">↑</button><button class="btn link" data-dn="${i}" aria-label="Move down">↓</button><button class="btn link" data-rm="${i}" aria-label="Remove">✕</button></span></div>`).join('');
        $$('[data-k]', mm.el).forEach(x => x.onchange = () => { st[x.dataset.i][x.dataset.k] = x.value; });
        $$('[data-rm]', mm.el).forEach(x => x.onclick = () => { st.splice(x.dataset.rm, 1); draw(); });
        $$('[data-up]', mm.el).forEach(x => x.onclick = () => { const i = +x.dataset.up; if (i) { [st[i - 1], st[i]] = [st[i], st[i - 1]]; draw(); } });
        $$('[data-dn]', mm.el).forEach(x => x.onclick = () => { const i = +x.dataset.dn; if (i < st.length - 1) { [st[i + 1], st[i]] = [st[i], st[i + 1]]; draw(); } });
      };
      draw();
      $('#add', mm.el).onclick = () => { const wonIdx = st.findIndex(s => s.kind !== 'open'); st.splice(wonIdx < 0 ? st.length : wonIdx, 0, { name: 'New stage', kind: 'open', probability: 50 }); draw(); };
      $('#sv', mm.el).onclick = async () => { try { await api('PUT', `pipelines/${p.id}/stages`, { stages: st }); mm.close(); await refreshMe(); toast('Stages saved'); render(); } catch (x) { $('.err', mm.el).textContent = x.message; } };
    });
  },
  async fields(el) {
    if (!can.pro('custom_fields')) { el.innerHTML = upgradeCard('Custom fields need the Pro plan.'); return; }
    const rows = await api('GET', 'fields');
    const edit = (f = {}) => formModal({ title: f.id ? 'Edit field' : 'New custom field', values: { entity: 'contacts', type: 'text', ...f, options: (f.options || []).join('\n') }, after: async () => { await refreshMe(); render(); },
      fields: [...(f.id ? [] : [{ k: 'entity', l: 'Record type', t: 'select', opts: [['contacts', 'Contacts'], ['companies', 'Companies'], ['deals', 'Deals']] }]), { k: 'label', l: 'Label', req: 1 },
        ...(f.id ? [] : [{ k: 'type', l: 'Type', t: 'select', opts: [['text', 'Text'], ['textarea', 'Long text'], ['number', 'Number'], ['date', 'Date'], ['select', 'Dropdown'], ['checkbox', 'Checkbox'], ['url', 'URL'], ['email', 'Email']] }]),
        { k: 'options', l: 'Dropdown options (one per line)', t: 'textarea', rows: 4 }, { k: 'required', l: 'Required', t: 'checkbox' }],
      submit: v => { v.options = v.options.split('\n').map(s => s.trim()).filter(Boolean); return f.id ? api('PATCH', 'fields/' + f.id, v) : api('POST', 'fields', v); }, del: f.id && (() => api('DELETE', 'fields/' + f.id)) });
    el.innerHTML = `<div class="row mb"><span class="grow small muted">Custom fields appear on forms and detail pages, and work in filters (<span class="kbd">custom.key=value</span>), imports, exports, automations and the API.</span><button class="btn" id="nf">＋ Field</button></div>
      ${table({ rows, onRow: edit, empty: 'No custom fields yet.', cols: [{ l: 'Label', f: f => `<b>${esc(f.label)}</b>${f.required ? ' <span class="tag warn">required</span>' : ''}` }, { l: 'Key', f: f => `<span class="kbd">${esc(f.key)}</span>` }, { l: 'Record', k: 'entity' }, { l: 'Type', k: 'type' }, { l: 'Options', f: f => esc((f.options || []).join(', ')) }] })}`;
    $('#nf', el).onclick = () => edit();
  },
  async integrations(el) {
    const keys = can.pro('api') ? await api('GET', 'api-keys') : [];
    const hooks = can.admin() && can.pro('api') ? await api('GET', 'webhooks') : [];
    const EVENTS = ['*', 'deal.created', 'deal.updated', 'deal.stage_changed', 'deal.won', 'deal.lost', 'contact.created', 'company.created', 'lead.created', 'quote.accepted', 'email.sent', 'email.received', 'email.opened', 'meeting.booked', 'task.completed'];
    el.innerHTML = !can.pro('api') ? upgradeCard('The REST API and webhooks need the Pro plan.') : `<div class="cols">
      <div class="card"><div class="row mb"><h3 class="grow">API keys</h3><button class="btn sm" id="nk">＋ Key</button></div>
        <p class="small muted">Use the REST API (Zapier, Make, your own code) with <span class="kbd">Authorization: Bearer crm_…</span>. Keys act as you, with your permissions.</p>
        ${keys.map(k => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--bd2)"><span class="grow"><b>${esc(k.name)}</b> <span class="kbd">${esc(k.prefix)}…</span><div class="small muted">${k.last_used ? 'used ' + fmt.rel(k.last_used) : 'never used'}</div></span><button class="btn link small" data-rk="${k.id}">Revoke</button></div>`).join('') || '<p class="muted small">No keys yet.</p>'}
        <details class="mt"><summary class="small">API quick reference</summary><pre class="code">GET    /api/contacts?q=&amp;owner_id=&amp;lifecycle=&amp;custom.key=
POST   /api/contacts        {name, email, …, custom:{}}
PATCH  /api/contacts/:id
GET    /api/deals?status=open|won|lost&amp;pipeline_id=
POST   /api/deals           {title, value, stage_id, contact_id}
GET    /api/companies · /api/activities
POST   /api/activities      {type, subject, note, due_date}
GET    /api/search?q=
GET    /api/export/:entity  (CSV)
POST   /api/import/:entity  {csv, mapping, mode}</pre></details></div>
      ${can.admin() ? `<div class="card"><div class="row mb"><h3 class="grow">Webhooks</h3><button class="btn sm" id="nh">＋ Webhook</button></div><p class="small muted">We POST JSON on events, signed with <span class="kbd">X-PipelineHQ-Signature: sha256=HMAC(secret, body)</span>. Failed deliveries retry with backoff.</p>
        ${hooks.map(h => `<div style="padding:6px 0;border-bottom:1px solid var(--bd2)"><div class="row"><b class="grow" style="word-break:break-all">${esc(h.url)}</b>${h.active ? '' : '<span class="tag gray">off</span>'}<button class="btn link small" data-th="${h.id}">Test</button><button class="btn link small" data-eh="${h.id}">Edit</button></div>
          <div class="small muted">${esc(h.events.join(', '))}</div><div class="small">Secret: <span class="kbd">${esc(h.secret)}</span></div></div>`).join('') || '<p class="muted small">No webhooks.</p>'}</div>` : ''}
      <div class="card"><h3>Connected services</h3>${[['Email delivery', ME.features.mail ? '✅ ' + ME.features.mail_provider : '⚠️ not configured — set RESEND_API_KEY or POSTMARK_TOKEN'], ['Google sign-in & Gmail', ME.features.google ? '✅ enabled' : '— set GOOGLE_CLIENT_ID / SECRET'],
        ['Billing (Stripe)', ME.features.stripe ? '✅ enabled' : '— set STRIPE_SECRET_KEY / PRICE_ID'], ['Click-to-call (Twilio)', ME.features.twilio ? '✅ enabled' : '— set TWILIO_*'], ['AI assistant (Claude)', ME.features.ai ? '✅ enabled' : '— set ANTHROPIC_API_KEY']]
        .map(([k, v]) => `<div class="row small" style="padding:4px 0"><span class="grow">${k}</span><span>${esc(v)}</span></div>`).join('')}
        <p class="small muted mt">Slack: add a “Post to Slack” action in Automations with an incoming-webhook URL.</p></div></div>`;
    $('#nk', el)?.addEventListener('click', () => formModal({ title: 'New API key', fields: [{ k: 'name', l: 'Name', req: 1, ph: 'e.g. Zapier' }], submit: async v => { const r = await api('POST', 'api-keys', v); modal('Your new API key', `<p>${esc(r.note)}</p><pre class="code">${esc(r.key)}</pre>`); }, after: () => render() }));
    $$('[data-rk]', el).forEach(b => b.onclick = async () => { if (await confirmBox('Revoke this key? Integrations using it will stop working.', { ok: 'Revoke' })) { await api('DELETE', 'api-keys/' + b.dataset.rk); render(); } });
    const editHook = (h = {}) => formModal({ title: h.id ? 'Edit webhook' : 'New webhook', values: { active: 1, events: ['*'], ...h }, after: () => render(),
      fields: [{ k: 'url', l: 'Endpoint URL', req: 1, ph: 'https://' }, { k: 'events', l: 'Events', t: 'multi', opts: EVENTS.map(e => [e, e === '*' ? 'All events' : e]) }, { k: 'active', l: 'Active', t: 'checkbox' }],
      submit: v => h.id ? api('PATCH', 'webhooks/' + h.id, v) : api('POST', 'webhooks', v), del: h.id && (() => api('DELETE', 'webhooks/' + h.id)) });
    $('#nh', el)?.addEventListener('click', () => editHook());
    $$('[data-eh]', el).forEach(b => b.onclick = () => editHook(hooks.find(h => h.id === Number(b.dataset.eh))));
    $$('[data-th]', el).forEach(b => b.onclick = async () => { await api('POST', `webhooks/${b.dataset.th}/test`); toast('Test event queued'); });
  },
  async billing(el, query) {
    if (query.get('ok')) toast('Thanks! Your subscription is being activated.');
    const b = await api('GET', 'billing'), cur = b.current;
    const plan = (k, p, price, list) => `<div class="card" style="${cur.plan === k ? 'outline:2px solid var(--pri)' : ''}"><div class="row"><h3 class="grow">${p.label}</h3>${cur.plan === k ? '<span class="tag">current</span>' : ''}</div><p style="font-size:20px;font-weight:650;margin:8px 0">${price}</p><ul class="small" style="padding-left:18px">${list.map(x => `<li>${x}</li>`).join('')}</ul></div>`;
    el.innerHTML = `<div class="cols">${plan('free', b.plans.free, 'Free', [`Up to ${b.plans.free.users} users`, `${b.plans.free.contacts} contacts`, '1 pipeline', 'Contacts, companies, deals, tasks', 'Email logging & templates', 'Reports, import/export'])}
      ${plan('pro', b.plans.pro, esc(b.price_label), ['Unlimited contacts & pipelines', 'Automations & sequences', 'AI assistant', 'Forecasting & quotas', 'Quotes with e-signature', 'Booking pages & web forms', 'Custom fields', 'API & webhooks'])}
      <div class="card"><h3>Usage</h3><dl class="kv mt"><dt>Users</dt><dd>${b.usage.users}${cur.users ? ' / ' + cur.users : ''}</dd><dt>Contacts</dt><dd>${b.usage.contacts}${cur.contacts ? ' / ' + cur.contacts : ''}</dd><dt>Pipelines</dt><dd>${b.usage.pipelines}${cur.pipelines ? ' / ' + cur.pipelines : ''}</dd>
        <dt>Status</dt><dd>${cur.trial_days_left ? `Pro trial · ${cur.trial_days_left} days left` : esc(b.sub_status || (b.org_plan === 'pro' ? 'active' : 'free'))}</dd>${b.org_plan === 'pro' ? `<dt>Seats</dt><dd>${b.seats}</dd>` : ''}</dl>
        <div class="row mt">${b.org_plan === 'pro' ? `<button class="btn ghost" id="portal">${b.stripe ? 'Manage subscription & invoices' : 'Downgrade to Free (dev)'}</button>` : `<label class="small">Seats <input type="number" id="seats" min="1" value="${Math.max(b.usage.users, 1)}" style="width:70px"></label><button class="btn" id="up">Upgrade to Pro</button>`}</div>
        ${b.stripe ? '' : '<p class="small muted mt">Dev mode: Stripe is not configured, so plan changes apply instantly without payment.</p>'}</div></div>`;
    $('#up', el)?.addEventListener('click', async () => { const r = await api('POST', 'billing/checkout', { seats: $('#seats', el).value }); if (r.url) location.href = r.url; else { await refreshMe(); toast('Upgraded to Pro'); render(); } });
    $('#portal', el)?.addEventListener('click', async () => { const r = await api('POST', 'billing/portal'); if (r.url) location.href = r.url; else { await refreshMe(); render(); } });
  },
  async audit(el, query) {
    const rows = await api('GET', `audit?${qs({ entity: query.get('entity'), user_id: query.get('user') })}`);
    el.innerHTML = `<div class="filters"><select id="ae">${[['', 'All records'], 'deal', 'contact', 'company', 'user', 'org', 'quote', 'pipeline', 'api_key', 'contacts', 'deals'].map(x => { const [v, l] = Array.isArray(x) ? x : [x, x]; return `<option value="${v}" ${query.get('entity') === v ? 'selected' : ''}>${l}</option>`; }).join('')}</select>
      <select id="au">${userOpts('All users', false).map(([v, l]) => `<option value="${v}" ${query.get('user') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      ${table({ rows, empty: 'No events.', cols: [{ l: 'When', f: a => `<span class="nowrap">${fmt.dt(a.at)}</span>` }, { l: 'User', f: a => esc(a.user_name || '—') + (a.impersonator_name ? ` <span class="tag warn">via ${esc(a.impersonator_name)}</span>` : '') }, { l: 'Action', f: a => `<b>${esc(a.action)}</b>` },
        { l: 'Record', f: a => a.entity ? `${esc(a.entity)}${a.entity_id ? ' #' + a.entity_id : ''}` : '' }, { l: 'Details', f: a => `<span class="small muted" style="word-break:break-word">${esc(typeof a.detail === 'object' ? JSON.stringify(a.detail) : a.detail || '')}</span>`.slice(0, 600) }, { l: 'IP', cls: 'hide-sm', f: a => `<span class="small muted">${esc(a.ip || '')}</span>` }] })}`;
    $('#ae', el).onchange = $('#au', el).onchange = () => go(`#/settings/audit?${qs({ entity: $('#ae', el).value, user: $('#au', el).value })}`);
  },
  async data(el) {
    el.innerHTML = `<div class="cols"><div class="card"><h3>Export everything</h3><p class="muted">Download all workspace data as JSON (GDPR data portability). Per-object CSV exports are on each list page.</p><a class="btn" href="/api/org/export">Download JSON export</a></div>
      <div class="card"><h3>Erase a person</h3><p class="muted">To honour a GDPR erasure request, use the button below or call <span class="kbd">DELETE /api/contacts/:id?erase=1</span> — this removes their emails, activities and audit trail.</p><button class="btn ghost" id="er">Erase a contact…</button></div>
      <div class="card" style="border-color:var(--bad)"><h3 style="color:var(--bad)">Delete workspace</h3><p class="muted">Permanently deletes ${esc(ME.org.name)}, all users, records, files and history. This cannot be undone.</p><button class="btn danger" id="dw">Delete workspace…</button></div></div>`;
    $('#er', el).onclick = async () => {
      const { rows } = await api('GET', 'contacts?limit=1000&sort=name');
      formModal({ title: 'Erase contact (GDPR)', fields: [{ k: 'id', l: 'Contact', t: 'select', opts: rows.map(c => [c.id, `${c.name} ${c.email ? '— ' + c.email : ''}`]), req: 1 }], submitLabel: 'Erase permanently',
        submit: async v => { if (!(await confirmBox('Erase this person and all their data permanently?', { ok: 'Erase' }))) return false; await api('DELETE', `contacts/${v.id}?erase=1`); toast('Erased'); } });
    };
    $('#dw', el).onclick = () => formModal({ title: 'Delete workspace', fields: [{ k: 'password', l: 'Your password', t: 'password' }, { k: 'confirm', l: `Type the workspace name (${ME.org.name}) if you sign in with Google` }], submitLabel: 'Delete everything',
      submit: async v => { await api('POST', 'org/delete', v); ME = null; $('#root').innerHTML = ''; go('#/signup'); } });
  },
};

// ---------------- super-admin console
route(/^\/admin$/, async main => {
  if (!ME.superadmin && !ME.impersonating) { main.innerHTML = '<div class="empty">Not available.</div>'; return; }
  if (ME.impersonating) { main.innerHTML = '<div class="card">You are impersonating a user. Stop impersonating (banner above) to use the admin console.</div>'; return; }
  const [s, orgs] = await Promise.all([api('GET', 'sa/stats'), api('GET', 'sa/orgs')]);
  main.innerHTML = `<div class="ph"><h2>Platform admin</h2></div><div class="stats">${stat('Workspaces', s.orgs)}${stat('Paying', s.paying)}${stat('Trialing', s.trialing)}${stat('Active users', s.users)}${stat('Signups (30d)', s.signups_30d)}${stat('Active orgs (7d)', s.active_7d)}${stat('Failed jobs', s.jobs_failed)}</div>
    <input type="search" id="of" placeholder="Filter workspaces" class="mb" style="max-width:320px">
    ${table({ rows: orgs, id: 'ot', cols: [{ l: 'Workspace', f: o => `<b>${esc(o.name)}</b><div class="small muted">${esc(o.owner_email || '')}</div>` }, { l: 'Plan', f: o => `<span class="tag">${esc(o.plan)}</span>${o.trial_ends_at > Date.now() ? ' <span class="tag gray">trial</span>' : ''}` },
      { l: 'Users', cls: 'n', k: 'users' }, { l: 'Contacts', cls: 'n', k: 'contacts' }, { l: 'Deals', cls: 'n', k: 'deals' }, { l: 'Last activity', f: o => fmt.rel(o.last_activity) }, { l: 'Created', f: o => fmt.date(o.created_at) },
      { l: '', f: o => `<button class="btn ghost sm" data-imp="${o.id}">Impersonate</button> <button class="btn ghost sm" data-plan="${o.id}">Plan…</button>` }] })}`;
  $('#of', main).oninput = e => $$('#ot tbody tr').forEach((tr, i) => tr.classList.toggle('hide', !(orgs[i].name + ' ' + orgs[i].owner_email).toLowerCase().includes(e.target.value.toLowerCase())));
  $$('[data-imp]', main).forEach(b => b.onclick = async () => { if (!(await confirmBox('Sign in as this workspace owner? This is recorded in their audit log.', { ok: 'Impersonate', danger: false }))) return; await api('POST', 'sa/impersonate', { org_id: Number(b.dataset.imp) }); ME = null; $('#root').innerHTML = ''; go('#/'); });
  $$('[data-plan]', main).forEach(b => b.onclick = () => formModal({ title: 'Change plan', fields: [{ k: 'plan', l: 'Plan', t: 'select', opts: [['', 'unchanged'], 'free', 'pro'] }, { k: 'trial_days', l: 'Set trial (days from now)', t: 'number' }, { k: 'seats', l: 'Seats', t: 'number' }],
    submit: v => api('POST', `sa/orgs/${b.dataset.plan}/plan`, { plan: v.plan || undefined, trial_days: v.trial_days === '' ? undefined : v.trial_days, seats: v.seats || undefined }), after: () => render() }));
});
