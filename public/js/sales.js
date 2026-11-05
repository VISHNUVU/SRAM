/* Sales pages: dashboard, email (outbox/templates/sequences), lead capture (forms/scoring/duplicates), meetings, quotes & products, forecast, reports, automations. */
'use strict';

const stat = (label, value, sub = '', ic = '', tone = '') => `<div class="stat ${tone}"><div class="sh"><span class="l">${esc(label)}</span>${ic ? `<span class="si">${icon(ic, 16)}</span>` : ''}</div><span class="v num">${value}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;

// ---------------- dashboard
route(/^\/$/, async (main, _, query) => {
  const d = await api('GET', `dashboard?${qs({ pipeline_id: query.get('p') })}`);
  const p = ME.pipelines.find(x => x.id === d.pipeline_id);
  main.innerHTML = `<div class="ph"><div class="grow"><h2>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${esc(ME.user.name.split(' ')[0])}</h2><p class="sub">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · here's your pipeline at a glance</p></div><a class="btn ghost" href="#/pipeline">${icon('pipeline', 16)} Open pipeline</a></div>
    <div class="stats">${stat('Open pipeline', fmt.money(d.open.v), `${d.open.n} open deals`, 'pipeline', 't1')}${stat('Weighted pipeline', fmt.money(d.open.w), 'value × stage probability', 'layers', 't2')}
      ${stat('Won this month', fmt.money(d.wonMonth.v), d.quota ? `${Chart.meter(d.myWon, d.quota)}<span>you: ${fmt.money(d.myWon)} of ${fmt.money(d.quota)} quota</span>` : `${d.wonMonth.n} deals`, 'trophy', 't3')}
      ${stat('Win rate', fmt.pct(d.winRate), 'last 90 days', 'percent', 't4')}${stat('New leads', d.newLeads, 'last 7 days', 'userplus', 't5')}</div>
    <div class="cols">
      <div class="card"><div class="row mb"><h3 class="grow">Pipeline by stage</h3>${ME.pipelines.length > 1 ? `<select id="dp" style="width:auto">${ME.pipelines.map(x => `<option value="${x.id}" ${x.id === d.pipeline_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : `<span class="muted small">${esc(p?.name || '')}</span>`}</div>
        ${d.byStage.some(s => s.n) ? Chart.hbars(d.byStage.map(s => ({ label: s.name, value: s.total, text: `${fmt.compact(s.total)} · ${s.n}`, tip: `${fmt.money(s.total)} across ${s.n} deal${s.n === 1 ? '' : 's'}` }))) : '<div class="empty">No deals yet. <a href="#/pipeline">Open the pipeline</a> to add one.</div>'}</div>
      <div class="card"><div class="row mb"><h3 class="grow">My tasks — today & overdue</h3><a class="small" href="#/tasks">All tasks →</a></div>
        ${d.tasks.map(t => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--bd2)"><input type="checkbox" data-done="${t.id}" aria-label="Complete"><span class="grow">${esc(t.subject || t.note || t.type)}<div class="small muted">${[t.deal_title, t.contact_name].filter(Boolean).map(esc).join(' · ')}</div></span>
          <span class="small ${t.due_date && t.due_date < fmt.today() ? 'err' : 'muted'}">${t.start_at ? fmt.dt(t.start_at) : fmt.date(t.due_date)}</span></div>`).join('') || '<div class="empty">Nothing due. 🎉</div>'}</div>
      <div class="card"><h3>Upcoming meetings</h3>${d.meetings.map(a => `<div class="row" style="padding:6px 0"><span class="grow">${icon('calendar', 14)} ${esc(a.subject || 'Meeting')}${a.contact_id ? ` · <a href="#/contacts/${a.contact_id}">${esc(a.contact_name)}</a>` : ''}</span><span class="small muted">${fmt.dt(a.start_at)}</span></div>`).join('') || '<p class="muted small">No meetings scheduled. Share a <a href="#/meetings">booking link</a>.</p>'}</div>
      <div class="card"><h3>Closing soon</h3>${d.closing.map(x => `<div class="row" style="padding:6px 0"><a class="grow" href="#/deals/${x.id}">${esc(x.title)}</a><span class="small ${x.close_date < fmt.today() ? 'err' : 'muted'}">${fmt.date(x.close_date)}</span><b class="num">${fmt.money(x.value)}</b></div>`).join('') || '<p class="muted small">No open deals with a close date.</p>'}</div>
      <div class="card"><h3>Recent activity</h3>${d.feed.filter((f, i, a) => !i || !(a[i - 1].user_name === f.user_name && a[i - 1].action === f.action && a[i - 1].entity_id === f.entity_id && a[i - 1].entity === f.entity)).slice(0, 8).map(f => `<div class="small" style="padding:5px 0;border-bottom:1px solid var(--bd2)"><b>${esc(f.user_name || 'Someone')}</b> ${esc(({ create: 'created', update: 'updated', delete: 'deleted', email: 'emailed', merge: 'merged into', upload: 'attached a file to', erase: 'erased' })[f.action] || f.action)} ${f.action === 'delete' || f.action === 'erase' ? esc(f.name || f.entity) : `<a href="#/${f.entity === 'company' ? 'companies' : f.entity + 's'}/${f.entity_id}">${esc(f.name || `${f.entity} #${f.entity_id}`)}</a>`} <span class="muted">· ${fmt.rel(f.at)}</span></div>`).join('') || '<p class="muted small">No activity yet.</p>'}</div>
    </div>`;
  $('#dp')?.addEventListener('change', e => go('#/?p=' + e.target.value));
  $$('[data-done]', main).forEach(c => c.onchange = async () => { await api('PATCH', 'activities/' + c.dataset.done, { done: true }); toast('Completed'); render(); });
});

// ---------------- email
route(/^\/email(?:\/(\w+))?(?:\/(\d+))?$/, async (main, m) => {
  const tab = m[1] || 'outbox';
  const head = `<div class="ph"><h2>Email</h2></div>${tabsHtml([['outbox', 'Sent & received', '#/email/outbox'], ['templates', 'Templates', '#/email/templates'], ['sequences', 'Sequences', '#/email/sequences']], tab)}`;
  const status = ME.user.gmail_connected ? `Sending from your Gmail (${esc(ME.user.google_email)}), replies sync automatically.` : ME.features.mail ? `Sending via ${esc(ME.features.mail_provider)}. Replies are logged when forwarded/BCC'd to <span class="kbd">${esc(ME.org.inbound_address)}</span>.`
    : `⚠️ No mail provider configured — emails are logged, not delivered. Set RESEND_API_KEY or POSTMARK_TOKEN${ME.features.google ? ', or <a href="#/settings/profile">connect Gmail</a>' : ''}.`;
  if (tab === 'outbox') {
    const rows = await api('GET', 'emails');
    main.innerHTML = head + `<p class="small muted">${status}</p>` + table({ rows, empty: 'No emails yet — send one from a contact.', onRow: e => showEmail(e.id),
      cols: [{ l: '', f: e => `<span class="ic-sm ${e.direction === 'in' ? 'in' : 'out'}">${icon(e.direction === 'in' ? 'inbox' : 'send', 15)}</span>` }, { l: 'Subject', f: e => `<b>${esc(e.subject)}</b>` }, { l: 'Contact', f: e => e.contact_id ? `<a href="#/contacts/${e.contact_id}">${esc(e.contact_name)}</a>` : esc(e.to_addr) },
        { l: 'Status', f: e => `<span class="tag ${e.status === 'failed' ? 'bad' : e.status === 'queued' ? 'warn' : e.status === 'received' ? '' : 'gray'}" ${e.error ? `data-tip="${esc(e.error)}"` : ''}>${esc(e.status)}</span>` },
        { l: 'Opens', cls: 'n', f: e => e.direction === 'out' ? e.open_count : '' }, { l: 'By', f: e => esc(e.user_name || '') }, { l: 'When', f: e => fmt.rel(e.sent_at || e.created_at) }] });
  } else if (tab === 'templates') {
    const rows = await api('GET', 'templates');
    const edit = (t = {}) => formModal({ title: t.id ? 'Edit template' : 'New template', values: t, wide: true, after: () => render(),
      fields: [{ k: 'name', l: 'Template name', req: 1 }, { k: 'subject', l: 'Subject', req: 1 }, { k: 'body', l: 'Body', t: 'textarea', rows: 10, req: 1,
        help: 'Merge fields: <span class="kbd">{{contact.first_name}}</span> <span class="kbd">{{contact.name}}</span> <span class="kbd">{{company.name}}</span> <span class="kbd">{{deal.title}}</span> <span class="kbd">{{user.name}}</span>' }],
      submit: v => t.id ? api('PATCH', 'templates/' + t.id, v) : api('POST', 'templates', v), del: t.id && (() => api('DELETE', 'templates/' + t.id)) });
    main.innerHTML = head + `<div class="row mb"><span class="grow muted small">Reusable emails with merge fields. Used in the composer, sequences and automations.</span><button class="btn" id="nt">＋ Template</button></div>` +
      table({ rows, onRow: edit, empty: 'No templates yet.', cols: [{ l: 'Name', f: t => `<b>${esc(t.name)}</b>` }, { l: 'Subject', k: 'subject' }, { l: 'Created', f: t => fmt.date(t.created_at) }] });
    $('#nt').onclick = () => edit();
  } else if (tab === 'sequences') {
    if (!can.pro('sequences')) { main.innerHTML = head + upgradeCard('Sequences need the Pro plan.'); return; }
    if (m[2]) return sequenceDetail(main, head, Number(m[2]));
    const rows = await api('GET', 'sequences');
    main.innerHTML = head + `<div class="row mb"><span class="grow muted small">Automated multi-step cadences. Contacts leave a sequence when they reply or unsubscribe.</span><button class="btn" id="ns">＋ Sequence</button></div>` +
      table({ rows, onRow: s => go('#/email/sequences/' + s.id), empty: 'No sequences yet.', cols: [{ l: 'Name', f: s => `<b>${esc(s.name)}</b>` }, { l: 'Steps', f: s => s.steps.length },
        { l: 'Active', cls: 'n', k: 'active_count' }, { l: 'Total enrolled', cls: 'n', k: 'total_count' }, { l: 'Reply rate', cls: 'n', f: s => s.total_count ? Math.round(100 * s.replied_count / s.total_count) + '%' : '—' }, { l: 'Status', f: s => s.active ? '<span class="tag ok">active</span>' : '<span class="tag gray">paused</span>' }] });
    $('#ns').onclick = () => sequenceEditor({});
  }
});
async function showEmail(id) { const e = await api('GET', 'emails/' + id); modal(e.subject, `<p class="small muted">${e.direction === 'in' ? 'From ' + esc(e.from_addr) : 'To ' + esc(e.to_addr)} · ${fmt.dt(e.sent_at || e.created_at)} · ${esc(e.status)}${e.error ? ' — ' + esc(e.error) : ''}</p><div style="white-space:pre-wrap">${esc(e.body)}</div>`, { wide: true }); }
async function sequenceEditor(s) {
  const tpls = await api('GET', 'templates'); if (!tpls.length) return toast('Create an email template first', 'bad');
  let steps = s.steps ? [...s.steps] : [{ type: 'email', delay_days: 0, template_id: tpls[0].id }];
  const m = modal(s.id ? 'Edit sequence' : 'New sequence', `<label class="f">Name</label><input id="sn" value="${esc(s.name || '')}"><label class="row mt" style="gap:6px"><input type="checkbox" id="sa" ${s.active !== 0 ? 'checked' : ''}> Active</label>
    <h4 class="mt">Steps</h4><div id="steps"></div><button class="btn ghost sm" id="add">＋ Add step</button><div class="err"></div><div class="mf">${s.id ? '<button class="btn danger" id="del">Delete</button>' : ''}<span class="sp"></span><button class="btn" id="save">Save</button></div>`, { wide: true });
  const draw = () => {
    $('#steps', m.el).innerHTML = steps.map((st, i) => `<div class="rowed"><span class="small"><b>Step ${i + 1}</b></span>
      <label class="small">Wait <input type="number" min="0" data-i="${i}" data-k="delay_days" value="${st.delay_days}" style="width:70px;display:inline-block"> day(s)${i ? ' after previous' : ' after enrolling'}</label>
      <select data-i="${i}" data-k="type"><option value="email" ${st.type === 'email' ? 'selected' : ''}>Send email</option><option value="task" ${st.type === 'task' ? 'selected' : ''}>Create task</option></select>
      ${st.type === 'email' ? `<select data-i="${i}" data-k="template_id">${tpls.map(t => `<option value="${t.id}" ${t.id === Number(st.template_id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : `<input data-i="${i}" data-k="note" value="${esc(st.note || '')}" placeholder="Task, e.g. Call them">`}
      <button class="btn link" data-rm="${i}" aria-label="Remove step">✕</button></div>`).join('');
    $$('[data-k]', m.el).forEach(el => el.onchange = () => { steps[el.dataset.i][el.dataset.k] = el.value; if (el.dataset.k === 'type') { if (el.value === 'email') steps[el.dataset.i].template_id ||= tpls[0].id; draw(); } });
    $$('[data-rm]', m.el).forEach(b => b.onclick = () => { steps.splice(b.dataset.rm, 1); draw(); });
  };
  draw();
  $('#add', m.el).onclick = () => { steps.push({ type: 'email', delay_days: 3, template_id: tpls[0].id }); draw(); };
  $('#del', m.el)?.addEventListener('click', async () => { if (await confirmBox('Delete this sequence and its enrollments?', { ok: 'Delete' })) { await api('DELETE', 'sequences/' + s.id); m.close(); go('#/email/sequences'); } });
  $('#save', m.el).onclick = async () => {
    try { const body = { name: $('#sn', m.el).value, active: $('#sa', m.el).checked, steps: steps.map(x => ({ ...x, delay_days: Number(x.delay_days) || 0 })) }; const r = s.id ? await api('PATCH', 'sequences/' + s.id, body) : await api('POST', 'sequences', body); m.close(); go('#/email/sequences/' + r.id); render(); }
    catch (x) { $('.err', m.el).textContent = x.message; }
  };
}
async function sequenceDetail(main, head, id) {
  const [s, en] = await Promise.all([api('GET', 'sequences/' + id), api('GET', `sequences/${id}/enrollments`)]);
  const tpls = await api('GET', 'templates');
  main.innerHTML = head + `<div class="ph"><div class="grow"><a class="small" href="#/email/sequences">← Sequences</a><h2>${esc(s.name)} ${s.active ? '<span class="tag ok">active</span>' : '<span class="tag gray">paused</span>'}</h2></div><button class="btn ghost" id="enroll">＋ Enroll contacts</button><button class="btn" id="ed">Edit</button></div>
    <div class="cols"><div class="card"><h3>Steps</h3><ol>${s.steps.map(st => `<li style="margin:6px 0">Day +${st.delay_days}: ${st.type === 'email' ? '✉️ ' + esc(tpls.find(t => t.id === st.template_id)?.name || 'template') : '✅ ' + esc(st.note || 'Task')}</li>`).join('')}</ol></div>
    <div class="card"><h3>Results</h3>${['active', 'finished', 'replied', 'unsubscribed', 'stopped'].map(k => `<div class="row"><span class="grow">${k}</span><b>${en.filter(e => e.status === k).length}</b></div>`).join('')}</div></div>
    <h3 class="mt mb">Enrolled contacts</h3>${table({ rows: en, empty: 'Nobody enrolled yet.', cols: [{ l: 'Contact', f: e => `<a href="#/contacts/${e.contact_id}">${esc(e.contact_name)}</a> <span class="small muted">${esc(e.contact_email || '')}</span>` },
      { l: 'Status', f: e => `<span class="tag ${e.status === 'active' ? '' : e.status === 'replied' ? 'ok' : 'gray'}">${esc(e.status)}</span>` }, { l: 'Step', f: e => `${Math.min(e.step + 1, s.steps.length)} / ${s.steps.length}` },
      { l: 'Next step', f: e => e.status === 'active' ? fmt.dt(new Date(e.next_run_at).toISOString()) : '' }, { l: '', f: e => e.status === 'active' ? `<button class="btn link small" data-stop="${e.id}">Stop</button>` : '' }] })}`;
  $('#ed').onclick = () => sequenceEditor(s);
  $$('[data-stop]', main).forEach(b => b.onclick = async () => { await api('POST', `enrollments/${b.dataset.stop}/stop`); render(); });
  $('#enroll').onclick = async () => {
    const { rows } = await api('GET', 'contacts?has_email=1&limit=1000&sort=name');
    const m = modal('Enroll contacts', `<input type="search" id="es" placeholder="Filter"><div class="tw mt" style="max-height:340px;overflow:auto">${rows.filter(c => !c.unsubscribed).map(c => `<label class="row" style="padding:6px 10px;gap:8px" data-n="${esc((c.name + ' ' + c.email).toLowerCase())}"><input type="checkbox" value="${c.id}"> ${esc(c.name)} <span class="small muted">${esc(c.email)}</span></label>`).join('') || '<div class="empty">No contacts with email.</div>'}</div><div class="mf"><span class="sp"></span><button class="btn" id="go">Enroll selected</button></div>`, { wide: true });
    $('#es', m.el).oninput = e => $$('[data-n]', m.el).forEach(l => l.classList.toggle('hide', !l.dataset.n.includes(e.target.value.toLowerCase())));
    $('#go', m.el).onclick = async () => { const ids = $$('input[type=checkbox]:checked', m.el).map(c => Number(c.value)); if (!ids.length) return; const r = await api('POST', `sequences/${id}/enroll`, { contact_ids: ids }); toast(`${r.enrolled} enrolled${r.errors.length ? `, ${r.errors.length} skipped` : ''}`); m.close(); render(); };
  };
}

// ---------------- lead capture
route(/^\/leads(?:\/(\w+))?$/, async (main, m) => {
  const tab = m[1] || 'forms';
  const head = `<div class="ph"><h2>Lead capture</h2></div>${tabsHtml([['forms', 'Web forms', '#/leads/forms'], ['scoring', 'Lead scoring', '#/leads/scoring'], ['duplicates', 'Duplicates', '#/leads/duplicates']], tab)}`;
  if (tab === 'forms') {
    if (!can.pro('forms')) { main.innerHTML = head + upgradeCard('Web-to-lead forms need the Pro plan.'); return; }
    const [rows, seqs] = await Promise.all([api('GET', 'forms'), can.pro('sequences') ? api('GET', 'sequences') : []]);
    const FIELDS = [['name', 'Name'], ['email', 'Email'], ['company', 'Company'], ['phone', 'Phone'], ['title', 'Job title'], ['message', 'Message'], ...(ME.fields.contacts || []).map(d => ['custom.' + d.key, d.label])];
    const edit = (f = {}) => formModal({ title: f.id ? 'Edit form' : 'New lead form', values: { assign_mode: 'round_robin', fields: ['name', 'email', 'company', 'message'], ...f }, after: () => render(),
      fields: [{ k: 'name', l: 'Form name', req: 1 }, { k: 'fields', l: 'Fields (email is required)', t: 'multi', opts: FIELDS },
        { k: 'assign_mode', l: 'Assign new leads', t: 'select', opts: [['round_robin', 'Round-robin across reps'], ['user', 'To a specific person'], ['none', 'Leave unassigned']] },
        { k: 'assign_user_id', l: 'Person (if specific)', t: 'select', opts: userOpts('—') }, { k: 'sequence_id', l: 'Auto-enroll in sequence', t: 'select', opts: [['', 'None'], ...seqs.map(s => [s.id, s.name])] },
        { k: 'redirect_url', l: 'Redirect after submit (optional)', ph: 'https://yoursite.com/thanks' }],
      submit: v => { if (!v.fields.includes('email')) v.fields.unshift('email'); return f.id ? api('PATCH', 'forms/' + f.id, v) : api('POST', 'forms', v); }, del: f.id && (() => api('DELETE', 'forms/' + f.id)) });
    const embed = f => { const url = `${ME.app_url}/f/${f.key}`; modal('Embed "' + f.name + '"', `<p><b>Hosted page</b> — share or link to it:</p><pre class="code">${esc(url)}</pre>
      <p><b>Iframe</b>:</p><pre class="code">${esc(`<iframe src="${url}" style="width:100%;height:560px;border:0"></iframe>`)}</pre>
      <p><b>Your own HTML form</b> — post to the same URL (field names: ${f.fields.map(esc).join(', ')}):</p><pre class="code">${esc(`<form action="${url}" method="POST">\n${f.fields.map(k => `  <input name="${k}"${k === 'email' ? ' type="email" required' : ''}>`).join('\n')}\n  <input name="_hp" style="display:none" tabindex="-1">\n  <button>Send</button>\n</form>`)}</pre>
      <p class="small muted">JSON works too: POST with Content-Type: application/json. The hidden _hp field is a spam honeypot.</p>`, { wide: true }); };
    main.innerHTML = head + `<div class="row mb"><span class="grow muted small">Capture leads from your website. New leads are scored, assigned and can trigger automations.</span><button class="btn" id="nf">＋ Form</button></div>` +
      table({ rows, empty: 'No forms yet.', onRow: edit, cols: [{ l: 'Form', f: f => `<b>${esc(f.name)}</b>` }, { l: 'Assignment', f: f => ({ round_robin: 'Round-robin', user: esc(user(f.assign_user_id)?.name || 'Specific user'), none: 'Unassigned' })[f.assign_mode] },
        { l: 'Submissions', cls: 'n', k: 'submissions' }, { l: '', f: f => `<a class="btn ghost sm" target="_blank" rel="noopener" href="/f/${esc(f.key)}">Open</a> <button class="btn ghost sm" data-embed="${f.id}">Embed code</button>` }] });
    $('#nf').onclick = () => edit();
    $$('[data-embed]', main).forEach(b => b.onclick = () => embed(rows.find(f => f.id === Number(b.dataset.embed))));
  } else if (tab === 'scoring') {
    const rows = await api('GET', 'scoring');
    const FIELDS = [['title', 'Job title'], ['email', 'Email'], ['source', 'Source'], ['lifecycle', 'Lifecycle stage'], ['company.industry', 'Company industry'], ['company.size', 'Company size'], ['_opens', 'Email opens (count)'], ['_replies', 'Email replies (count)'], ['_meetings', 'Meetings (count)'], ...(ME.fields.contacts || []).map(d => ['custom.' + d.key, d.label])];
    const OPS = [['contains', 'contains'], ['eq', 'equals'], ['neq', 'does not equal'], ['gt', 'greater than'], ['lt', 'less than'], ['not_empty', 'is set'], ['empty', 'is empty'], ['business_email', 'is a business email (not Gmail etc.)']];
    const edit = (r = {}) => formModal({ title: r.id ? 'Edit rule' : 'New scoring rule', values: { points: 10, ...r }, after: () => render(),
      fields: [{ k: 'field', l: 'When', t: 'select', opts: FIELDS }, { k: 'op', l: 'Condition', t: 'select', opts: OPS }, { k: 'value', l: 'Value' }, { k: 'points', l: 'Add points (negative to subtract)', t: 'number', req: 1 }],
      submit: v => r.id ? api('PATCH', 'scoring/' + r.id, v) : api('POST', 'scoring', v), del: r.id && (() => api('DELETE', 'scoring/' + r.id)) });
    main.innerHTML = head + `<div class="row mb"><span class="grow muted small">Scores update automatically when contacts change, open emails, reply or book meetings.</span>${can.manage() ? '<button class="btn ghost" id="rc">Recalculate all</button><button class="btn" id="nr">＋ Rule</button>' : ''}</div>` +
      table({ rows, empty: 'No rules.', onRow: can.manage() ? edit : null, cols: [{ l: 'When', f: r => esc(FIELDS.find(f => f[0] === r.field)?.[1] || r.field) }, { l: 'Condition', f: r => esc(OPS.find(o => o[0] === r.op)?.[1] || r.op) + (r.value ? ` <b>${esc(r.value)}</b>` : '') }, { l: 'Points', cls: 'n', f: r => (r.points > 0 ? '+' : '') + r.points }] });
    $('#nr')?.addEventListener('click', () => edit());
    $('#rc')?.addEventListener('click', async () => { const r = await api('POST', 'scoring/recalculate'); toast(`${r.updated} contacts re-scored`); });
  } else {
    const [c, co] = await Promise.all([api('GET', 'duplicates/contacts'), api('GET', 'duplicates/companies')]);
    const group = (ent, g) => `<div class="card mb"><div class="row mb"><b class="grow">${g.records.length} ${ent} — matching ${esc(g.reason)}</b><button class="btn sm" data-merge='${esc(JSON.stringify({ ent, ids: g.records.map(r => r.id) }))}'>Merge…</button></div>
      ${g.records.map(r => `<div class="row small" style="padding:3px 0"><a href="#/${ent}/${r.id}" class="grow">${esc(r.name)}</a><span class="muted">${esc(r.email || r.domain || r.company_name || '')}</span><span class="muted">created ${fmt.date(r.created_at)}</span></div>`).join('')}</div>`;
    main.innerHTML = head + (c.length + co.length ? '' : '<div class="empty">No duplicates found. 🎉</div>') + c.map(g => group('contacts', g)).join('') + co.map(g => group('companies', g)).join('');
    $$('[data-merge]', main).forEach(b => b.onclick = () => {
      const { ent, ids } = JSON.parse(b.dataset.merge); const recs = [...c, ...co].flatMap(g => g.records).filter(r => ids.includes(r.id));
      formModal({ title: 'Merge records', fields: [{ k: 'keep', l: 'Keep this record (others are merged into it — empty fields are filled, activity moves over)', t: 'select', opts: recs.map(r => [r.id, `${r.name} — ${r.email || r.domain || 'created ' + fmt.date(r.created_at)}`]) }], submitLabel: 'Merge',
        submit: v => api('POST', 'merge/' + ent, { keep_id: Number(v.keep), merge_ids: ids.filter(i => i !== Number(v.keep)) }), after: () => { toast('Merged'); render(); } });
    });
  }
});

// ---------------- meetings
route(/^\/meetings$/, async main => {
  const [pages, { rows: upcoming }] = await Promise.all([can.pro('booking') ? api('GET', 'booking-pages') : [], api('GET', 'activities?type=meeting&due=upcoming&mine=1&sort=start_at&limit=50')]);
  const feed = `${ME.app_url}/cal/${ME.user.calendar_token}.ics`;
  const edit = (b = {}) => formModal({ title: b.id ? 'Edit booking page' : 'New booking page', values: { duration_min: 30, days: '1,2,3,4,5', start_hour: 9, end_hour: 17, timezone: ME.org.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, user_id: ME.user.id, active: 1, slug: b.id ? b.slug : ME.user.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-30min', ...b, days_arr: (b.days || '1,2,3,4,5').split(',') }, cols2: true, after: () => render(),
    fields: [{ k: 'title', l: 'Meeting name', req: 1, ph: 'Product demo' }, { k: 'slug', l: 'Link name', req: 1, help: `${esc(ME.app_url)}/book/<b>link-name</b>` },
      { k: 'duration_min', l: 'Duration (min)', t: 'number', req: 1 }, { k: 'timezone', l: 'Time zone', req: 1 }, { k: 'start_hour', l: 'Available from (hour, 0–23)', t: 'number' }, { k: 'end_hour', l: 'Until (hour, 1–24)', t: 'number' },
      { k: 'days_arr', l: 'Days', t: 'multi', opts: [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']] },
      ...(can.manage() ? [{ k: 'user_id', l: 'Host', t: 'select', opts: userOpts('—').slice(1) }] : []), { k: 'active', l: 'Active', t: 'checkbox' }],
    submit: v => { v.days = v.days_arr.join(','); delete v.days_arr; return b.id ? api('PATCH', 'booking-pages/' + b.id, v) : api('POST', 'booking-pages', v); }, del: b.id && (() => api('DELETE', 'booking-pages/' + b.id)) });
  main.innerHTML = `<div class="ph"><h2>Meetings</h2>${can.pro('booking') ? '<button class="btn" id="nb">＋ Booking page</button>' : ''}</div>
    <div class="cols"><div class="card"><h3>Calendar sync</h3><p class="small muted">Subscribe to this private feed in Google Calendar, Outlook or Apple Calendar to see your CRM tasks and meetings. (Keep it secret — anyone with the link can read it.)</p><pre class="code">${esc(feed)}</pre>
      <button class="btn ghost sm" id="cp">Copy link</button> <button class="btn ghost sm" id="rg">Reset link</button></div>
    <div class="card"><h3>Upcoming meetings</h3>${upcoming.map(a => `<div class="row" style="padding:6px 0"><span class="grow">${esc(a.subject || 'Meeting')}${a.contact_id ? ` · <a href="#/contacts/${a.contact_id}">${esc(a.contact_name)}</a>` : ''}</span><span class="small muted">${fmt.dt(a.start_at)}</span></div>`).join('') || '<p class="muted small">Nothing scheduled.</p>'}</div></div>
    <h3 class="mt mb">Booking pages</h3>${can.pro('booking') ? table({ rows: pages, onRow: edit, empty: 'Create a booking page so prospects can pick a time on your calendar.', cols: [{ l: 'Meeting', f: b => `<b>${esc(b.title)}</b> ${b.active ? '' : '<span class="tag gray">off</span>'}` }, { l: 'Host', k: 'user_name' }, { l: 'Length', f: b => b.duration_min + ' min' },
      { l: 'Hours', f: b => `${b.start_hour}:00–${b.end_hour}:00 ${esc(b.timezone)}` }, { l: 'Link', f: b => `<a href="/book/${esc(b.slug)}" target="_blank" rel="noopener">/book/${esc(b.slug)}</a>` }] }) : upgradeCard('Booking pages need the Pro plan.')}`;
  $('#nb')?.addEventListener('click', () => edit());
  $('#cp').onclick = () => navigator.clipboard.writeText(feed).then(() => toast('Copied'));
  $('#rg').onclick = async () => { if (await confirmBox('Reset the link? Existing calendar subscriptions will stop updating.', { ok: 'Reset' })) { const r = await api('POST', 'me/calendar-token'); ME.user.calendar_token = r.calendar_token; render(); } };
});

// ---------------- quotes & products
route(/^\/quotes(?:\/(\w+))?$/, async (main, m) => {
  if (!can.pro('quotes')) { main.innerHTML = '<div class="ph"><h2>Quotes</h2></div>' + upgradeCard('Quotes need the Pro plan.'); return; }
  if (m[1] && /^\d+$/.test(m[1])) return quoteEditor(main, Number(m[1]));
  const tab = m[1] || 'list';
  const head = `<div class="ph"><h2>Quotes</h2></div>${tabsHtml([['list', 'Quotes', '#/quotes'], ['products', 'Products', '#/quotes/products'], ['pricebooks', 'Price books', '#/quotes/pricebooks']], tab)}`;
  if (tab === 'list') {
    const rows = await api('GET', 'quotes');
    main.innerHTML = head + `<p class="small muted">Create a quote from any deal. Customers review and e-sign online.</p>` + table({ rows, onRow: q => go('#/quotes/' + q.id), empty: 'No quotes yet — open a deal and click “＋ Quote”.',
      cols: [{ l: 'Number', f: q => `<b>${esc(q.number)}</b>` }, { l: 'Deal', f: q => `<a href="#/deals/${q.deal_id}">${esc(q.deal_title)}</a>` }, { l: 'Status', f: q => `<span class="tag ${q.status === 'accepted' ? 'ok' : q.status === 'declined' ? 'bad' : q.status === 'sent' ? '' : 'gray'}">${esc(q.status)}</span>${q.viewed_at && q.status === 'sent' ? ' <span class="small muted">viewed</span>' : ''}` },
        { l: 'Total', cls: 'n', f: q => fmt.money2(q.total) }, { l: 'Created', f: q => fmt.date(q.created_at) }] });
  } else if (tab === 'products') {
    const rows = await api('GET', 'products');
    const edit = (p = {}) => formModal({ title: p.id ? 'Edit product' : 'New product', values: { active: 1, ...p }, after: () => render(), fields: [{ k: 'name', l: 'Name', req: 1 }, { k: 'sku', l: 'SKU' }, { k: 'price', l: `List price (${ME.org.currency})`, t: 'number', req: 1 }, { k: 'description', l: 'Description', t: 'textarea', rows: 2 }, { k: 'active', l: 'Active', t: 'checkbox' }],
      submit: v => p.id ? api('PATCH', 'products/' + p.id, v) : api('POST', 'products', v), del: p.id && (() => api('DELETE', 'products/' + p.id)) });
    main.innerHTML = head + `<div class="row mb"><span class="grow"></span>${can.manage() ? '<button class="btn" id="np">＋ Product</button>' : ''}</div>` + table({ rows, onRow: can.manage() ? edit : null, empty: 'No products yet.', cols: [{ l: 'Product', f: p => `<b>${esc(p.name)}</b> ${p.active ? '' : '<span class="tag gray">inactive</span>'}` }, { l: 'SKU', k: 'sku' }, { l: 'List price', cls: 'n', f: p => fmt.money2(p.price) }] });
    $('#np')?.addEventListener('click', () => edit());
  } else {
    const books = await api('GET', 'price-books');
    main.innerHTML = head + `<div class="row mb"><span class="grow small muted">Price books override list prices — e.g. partner or regional pricing. Pick one when creating a quote.</span>${can.manage() ? '<button class="btn" id="nb">＋ Price book</button>' : ''}</div>` + table({ rows: books, empty: 'No price books.', onRow: can.manage() ? async b => {
      const entries = await api('GET', `price-books/${b.id}/entries`);
      const mm = modal('Price book: ' + b.name, `${table({ rows: entries, cols: [{ l: 'Product', k: 'name' }, { l: 'List', cls: 'n', f: e => fmt.money2(e.list_price) }, { l: 'Price in this book', f: e => `<input type="number" step="any" data-p="${e.product_id}" value="${e.price ?? ''}" placeholder="use list price">` }] })}
        <div class="mf"><button class="btn danger" id="del">Delete book</button><span class="sp"></span><button class="btn" id="sv">Save prices</button></div>`, { wide: true });
      $('#sv', mm.el).onclick = async () => { await api('PUT', `price-books/${b.id}/entries`, { entries: $$('[data-p]', mm.el).map(i => ({ product_id: i.dataset.p, price: i.value })) }); mm.close(); toast('Saved'); };
      $('#del', mm.el).onclick = async () => { if (await confirmBox('Delete this price book?', { ok: 'Delete' })) { await api('DELETE', 'price-books/' + b.id); mm.close(); render(); } };
    } : null, cols: [{ l: 'Name', f: b => `<b>${esc(b.name)}</b>` }] });
    $('#nb')?.addEventListener('click', () => formModal({ title: 'New price book', fields: [{ k: 'name', l: 'Name', req: 1 }], submit: v => api('POST', 'price-books', v), after: () => render() }));
  }
});
async function quoteEditor(main, id) {
  const [q, products] = await Promise.all([api('GET', 'quotes/' + id), api('GET', 'products')]);
  const locked = q.status === 'accepted';
  let items = q.items.map(i => ({ ...i }));
  const draw = () => {
    main.innerHTML = `<div class="ph"><div class="grow"><a class="small" href="#/deals/${q.deal_id}">← ${esc(q.deal.title)}</a><h2>Quote ${esc(q.number)} <span class="tag ${q.status === 'accepted' ? 'ok' : q.status === 'declined' ? 'bad' : 'gray'}">${esc(q.status)}</span></h2>
      ${q.status === 'accepted' ? `<div class="small" style="color:var(--ok)">✓ Signed by ${esc(q.signed_name)} · ${fmt.dt(q.signed_at)} · IP ${esc(q.signed_ip)}</div>` : q.viewed_at ? `<div class="small muted">Viewed by customer ${fmt.rel(q.viewed_at)}</div>` : ''}</div>
      <a class="btn ghost" href="${esc(q.public_url)}" target="_blank" rel="noopener">Preview / PDF</a>${locked ? '' : '<button class="btn ghost" id="send">Send to customer</button><button class="btn" id="save">Save</button>'}<button class="btn ghost" id="del" aria-label="Delete quote">🗑</button></div>
      <div class="card"><div class="grid2"><div><label class="f">Title</label><input id="qt" value="${esc(q.title || '')}" ${locked ? 'disabled' : ''}></div><div><label class="f">Valid until</label><input type="date" id="qv" value="${esc(q.valid_until || '')}" ${locked ? 'disabled' : ''}></div></div>
      <h4 class="mt mb">Line items</h4><div class="tw"><table class="t"><tr><th>Product / description</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Disc %</th><th class="n">Total</th><th></th></tr>
      ${items.map((it, i) => `<tr><td><div class="row" style="flex-wrap:nowrap"><select data-i="${i}" data-k="product_id" style="max-width:160px" ${locked ? 'disabled' : ''}><option value="">Custom</option>${products.filter(p => p.active || p.id === it.product_id).map(p => `<option value="${p.id}" ${p.id === Number(it.product_id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select><input data-i="${i}" data-k="name" value="${esc(it.name || '')}" placeholder="Description" ${locked ? 'disabled' : ''}></div></td>
        <td><input data-i="${i}" data-k="qty" type="number" step="any" value="${it.qty}" style="width:70px" ${locked ? 'disabled' : ''}></td><td><input data-i="${i}" data-k="unit_price" type="number" step="any" value="${it.unit_price ?? ''}" style="width:110px" ${locked ? 'disabled' : ''}></td>
        <td><input data-i="${i}" data-k="discount_pct" type="number" step="any" value="${it.discount_pct || 0}" style="width:70px" ${locked ? 'disabled' : ''}></td><td class="n">${fmt.money2((Number(it.qty) || 0) * (Number(it.unit_price) || 0) * (1 - (Number(it.discount_pct) || 0) / 100))}</td>
        <td>${locked ? '' : `<button class="btn link" data-rm="${i}" aria-label="Remove line">✕</button>`}</td></tr>`).join('')}</table></div>
      ${locked ? '' : '<button class="btn ghost sm mt" id="add">＋ Line item</button>'}
      <div class="grid2 mt"><div><label class="f">Notes / terms (shown to customer)</label><textarea id="qn" rows="4" ${locked ? 'disabled' : ''}>${esc(q.notes || '')}</textarea></div>
        <div><div class="row"><label class="f grow">Quote discount %</label><input id="qd" type="number" step="any" value="${q.discount_pct}" style="width:90px" ${locked ? 'disabled' : ''}></div><div class="row"><label class="f grow">Tax %</label><input id="qx" type="number" step="any" value="${q.tax_pct}" style="width:90px" ${locked ? 'disabled' : ''}></div>
        <dl class="kv mt" style="grid-template-columns:1fr auto"><dt>Subtotal</dt><dd class="num right">${fmt.money2(q.subtotal)}</dd><dt>Discount</dt><dd class="num right">−${fmt.money2(q.discount)}</dd><dt>Tax</dt><dd class="num right">${fmt.money2(q.tax)}</dd><dt><b>Total</b></dt><dd class="num right"><b>${fmt.money2(q.total)}</b></dd></dl>
        <p class="small muted">Totals refresh when you save.</p></div></div></div>`;
    $$('[data-k]', main).forEach(el => el.onchange = () => { const it = items[el.dataset.i]; it[el.dataset.k] = el.value; if (el.dataset.k === 'product_id') { const p = products.find(x => x.id === Number(el.value)); if (p) { it.name = p.name; it.unit_price = ''; } } if (['product_id'].includes(el.dataset.k)) draw(); });
    $$('[data-rm]', main).forEach(b => b.onclick = () => { items.splice(b.dataset.rm, 1); draw(); });
    $('#add', main)?.addEventListener('click', () => { items.push({ qty: 1, unit_price: '', discount_pct: 0, name: '' }); draw(); });
    $('#save', main)?.addEventListener('click', () => save().then(() => toast('Saved')).catch(fail));
    $('#send', main)?.addEventListener('click', async () => { try { await save(); await api('POST', `quotes/${id}/send`, {}); toast('Quote emailed to the customer'); quoteEditor(main, id); } catch (x) { fail(x); } });
    $('#del', main).onclick = async () => { if (await confirmBox('Delete this quote?', { ok: 'Delete' })) { await api('DELETE', 'quotes/' + id); go('#/deals/' + q.deal_id); } };
  };
  const save = async () => {
    Object.assign(q, await api('PATCH', 'quotes/' + id, { title: $('#qt').value, valid_until: $('#qv').value, notes: $('#qn').value, discount_pct: $('#qd').value, tax_pct: $('#qx').value }));
    Object.assign(q, await api('PUT', `quotes/${id}/items`, { items }));
    items = q.items.map(i => ({ ...i })); draw();
  };
  draw();
}

// ---------------- forecast
route(/^\/forecast$/, async (main, _, query) => {
  if (!can.pro('forecast')) { main.innerHTML = '<div class="ph"><h2>Forecast</h2></div>' + upgradeCard('Forecasting needs the Pro plan.'); return; }
  const period = query.get('period') || new Date().toISOString().slice(0, 7), pid = query.get('p') || '';
  const f = await api('GET', `forecast?${qs({ period, pipeline_id: pid })}`);
  main.innerHTML = `<div class="ph"><h2>Forecast</h2>${ME.pipelines.length > 1 ? `<select id="fp" style="width:auto"><option value="">All pipelines</option>${ME.pipelines.map(p => `<option value="${p.id}" ${String(p.id) === pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}</div>
    <div class="card mb"><h3>Next 6 months</h3><p class="small muted">Won = closed. Weighted = won + open × stage probability. Best case = won + all open deals with a close date in the month.</p>
      ${Chart.columns(f.series.map(s => ({ label: monthLabel(s.month), values: { won: s.won, weighted: s.weighted, best: s.best }, quota: s.quota })), [{ key: 'won', label: 'Won' }, { key: 'weighted', label: 'Weighted', cls: 's2' }, { key: 'best', label: 'Best case', cls: 's3' }], { quota: true })}
      <details class="mt"><summary class="small muted">Show table</summary>${table({ rows: f.series, cols: [{ l: 'Month', f: s => monthLabel(s.month) }, { l: 'Won', cls: 'n', f: s => fmt.money(s.won) }, { l: 'Commit (≥75%)', cls: 'n', f: s => fmt.money(s.commit) }, { l: 'Weighted', cls: 'n', f: s => fmt.money(s.weighted) }, { l: 'Best case', cls: 'n', f: s => fmt.money(s.best) }, { l: 'Open deals', cls: 'n', k: 'open_deals' }, { l: 'Quota', cls: 'n', f: s => s.quota ? fmt.money(s.quota) : '—' }] })}</details>
      ${f.undated.n || f.overdue.n ? `<p class="small mt">⚠️ ${f.overdue.n ? `<a href="#/deals?status=open&close_to=${fmt.today()}">${f.overdue.n} open deals (${fmt.money(f.overdue.v)}) are past their close date</a>. ` : ''}${f.undated.n ? `${f.undated.n} open deals (${fmt.money(f.undated.v)}) have no close date and aren't forecast.` : ''}</p>` : ''}</div>
    <div class="card"><div class="row mb"><h3 class="grow">Rep attainment</h3><input type="month" id="per" value="${period}" style="width:auto" aria-label="Period"></div>
      ${table({ rows: f.reps, empty: 'No reps.', cols: [{ l: 'Rep', k: 'name' }, { l: 'Won', cls: 'n', f: r => fmt.money(r.won) }, { l: 'Weighted', cls: 'n', f: r => fmt.money(r.weighted) }, { l: 'Pipeline closing', cls: 'n', f: r => fmt.money(r.pipeline) },
        { l: 'Quota', cls: 'n', f: r => can.manage() ? `<input type="number" data-q="${r.user_id}" value="${r.quota ?? ''}" placeholder="set" style="width:110px;text-align:right">` : r.quota ? fmt.money(r.quota) : '—' },
        { l: 'Attainment', f: r => r.quota ? `<div class="row" style="flex-wrap:nowrap">${Chart.meter(r.won, r.quota)}<span class="small num">${r.attainment}%</span></div>` : '<span class="muted small">no quota</span>' }] })}</div>`;
  $('#fp')?.addEventListener('change', e => go(`#/forecast?${qs({ period, p: e.target.value })}`));
  $('#per').onchange = e => go(`#/forecast?${qs({ period: e.target.value, p: pid })}`);
  $$('[data-q]', main).forEach(i => i.onchange = async () => { try { await api('PUT', 'quotas', { user_id: i.dataset.q, period, amount: i.value }); toast('Quota saved'); render(); } catch (x) { fail(x); } });
});

// ---------------- reports
route(/^\/reports$/, async (main, _, query) => {
  const preset = query.get('range') || '90';
  const to = query.get('to') || fmt.today();
  const from = query.get('from') || (preset === 'ytd' ? new Date().getFullYear() + '-01-01' : preset === 'mtd' ? fmt.today().slice(0, 8) + '01' : new Date(Date.now() - Number(preset) * 864e5).toISOString().slice(0, 10));
  const r = await api('GET', `reports?${qs({ from, to, pipeline_id: query.get('p') })}`);
  const s = r.summary;
  main.innerHTML = `<div class="ph"><h2>Reports</h2>
    <select id="rr" style="width:auto">${[['mtd', 'Month to date'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', 'Last 6 months'], ['365', 'Last 12 months'], ['ytd', 'Year to date']].map(([v, l]) => `<option value="${v}" ${preset === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    ${ME.pipelines.length > 1 ? `<select id="rp" style="width:auto">${ME.pipelines.map(p => `<option value="${p.id}" ${p.id === r.pipeline_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}</div>
    <p class="small muted mb">${fmt.date(r.from)} – ${fmt.date(r.to)}${ME.user.role === 'rep' ? ' · your deals' : ME.user.role === 'manager' ? ' · your team' : ''}</p>
    <div class="stats">${stat('Revenue won', fmt.money(s.won_value), `${s.won || 0} deals`, 'trophy', 't3')}${stat('Win rate', fmt.pct(s.win_rate), `${s.won || 0} won · ${s.lost || 0} lost`, 'percent', 't4')}${stat('Average deal', fmt.money(s.avg_deal), 'won deals', 'dollar', 't1')}${stat('Sales cycle', s.avg_cycle != null ? Math.round(s.avg_cycle) + ' days' : '—', 'created → won', 'calendar', 't2')}
      ${stat('Email open rate', r.email.sent ? Math.round(100 * r.email.opened / r.email.sent) + '%' : '—', `${r.email.sent || 0} sent · ${r.email.replies || 0} replies`, 'mail', 't5')}</div>
    <div class="cols"><div class="card"><h3>Conversion funnel</h3><p class="small muted">Deals created in this period that reached each stage.</p>${r.funnel[0]?.count ? Chart.hbars(r.funnel.map(f => ({ label: f.stage, value: f.count, text: `${f.count}${f.conversion != null ? ` · ${f.conversion}%` : ''}`, tip: `${f.count} deals${f.conversion != null ? ` · ${f.conversion}% from previous stage` : ''}` })), { fmt: v => String(v), ordinal: true }) : '<div class="empty">No deals created in this period.</div>'}</div>
      <div class="card"><h3>Won revenue — last 12 months</h3>${r.won_by_month.length ? Chart.columns(r.won_by_month.map(x => ({ label: monthLabel(x.month), short: monthLabel(x.month).split(' ')[0], values: { v: x.value } })), [{ key: 'v', label: 'Won' }]) : '<div class="empty">No won deals yet.</div>'}</div>
      <div class="card"><h3>Lost reasons</h3>${r.lost_reasons.length ? Chart.hbars(r.lost_reasons.map(x => ({ label: x.reason, value: x.n, text: `${x.n} · ${fmt.compact(x.value)}`, tip: `${x.n} deals · ${fmt.money(x.value)}` })), { fmt: v => String(v) }) : '<div class="empty">No lost deals. 🎉</div>'}</div>
      <div class="card"><h3>Leads by source</h3>${r.leads_by_source.length ? table({ rows: r.leads_by_source, cols: [{ l: 'Source', k: 'source' }, { l: 'Leads', cls: 'n', k: 'n' }, { l: 'Customers', cls: 'n', k: 'customers' }, { l: 'Conv.', cls: 'n', f: x => Math.round(100 * x.customers / x.n) + '%' }] }) : '<div class="empty">No new contacts in this period.</div>'}</div></div>
    <div class="card mt"><h3>Leaderboard</h3>${table({ rows: r.leaderboard, cols: [{ l: 'Rep', k: 'name' }, { l: 'Won', cls: 'n', f: x => fmt.money(x.won_value) }, { l: 'Deals won', cls: 'n', f: x => x.won || 0 }, { l: 'Win rate', cls: 'n', f: x => x.won + x.lost ? Math.round(100 * x.won / (x.won + x.lost)) + '%' : '—' }, { l: 'Open pipeline', cls: 'n', f: x => fmt.money(x.open_value) },
      { l: 'Activities done', cls: 'n', k: 'activities' }, { l: 'Emails', cls: 'n', k: 'emails' }, { l: 'Meetings', cls: 'n', k: 'meetings' }] })}</div>
    <div class="card mt"><h3>Activity by type</h3>${table({ rows: r.activity_by_type, empty: 'No activity logged.', cols: [{ l: 'Type', f: x => `${TL_ICON[x.type] || ''} ${esc(x.type)}` }, { l: 'Logged', cls: 'n', k: 'n' }, { l: 'Completed', cls: 'n', k: 'done' }] })}</div>`;
  $('#rr').onchange = e => go(`#/reports?${qs({ range: e.target.value, p: query.get('p') })}`);
  $('#rp')?.addEventListener('change', e => go(`#/reports?${qs({ range: preset, p: e.target.value })}`));
});

// ---------------- automations
route(/^\/automations$/, async main => {
  if (!can.pro('automation')) { main.innerHTML = '<div class="ph"><h2>Automations</h2></div>' + upgradeCard('Automations need the Pro plan.'); return; }
  const [rows, meta, tpls, seqs] = await Promise.all([api('GET', 'workflows'), api('GET', 'workflows/meta'), api('GET', 'templates'), can.pro('sequences') ? api('GET', 'sequences') : []]);
  const TR = { 'deal.created': 'A deal is created', 'deal.updated': 'A deal is updated', 'deal.stage_changed': 'A deal changes stage', 'deal.won': 'A deal is won', 'deal.lost': 'A deal is lost', 'contact.created': 'A contact is created', 'lead.created': 'A new lead arrives (form, import, manual)',
    'quote.accepted': 'A quote is accepted', 'email.received': 'A contact replies by email', 'email.opened': 'A contact opens an email', 'meeting.booked': 'A meeting is booked', 'task.completed': 'A task is completed' };
  const AC = { create_task: 'Create a task', notify: 'Send a notification', send_email: 'Send an email template', update_deal: 'Update a deal field', update_contact: 'Update a contact field', enroll_sequence: 'Enroll contact in a sequence', assign_round_robin: 'Assign round-robin', webhook: 'POST to a webhook URL', slack: 'Post to Slack' };
  const FIELD_HINTS = ['deal.value', 'deal.title', 'stage.name', 'to_stage.name', 'from_stage.name', 'deal.lost_reason', 'contact.lifecycle', 'contact.source', 'contact.lead_score', 'contact.title', 'company.industry', 'company.size', ...(ME.fields.deals || []).map(d => 'deal.custom.' + d.key), ...(ME.fields.contacts || []).map(d => 'contact.custom.' + d.key)];
  const actionFields = a => {
    const sel = (k, opts, v) => `<select data-ak="${k}">${opts.map(o => { const [ov, ol] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(ov)}" ${String(ov) === String(v ?? '') ? 'selected' : ''}>${esc(ol)}</option>`; }).join('')}</select>`;
    const inp = (k, ph, v) => `<input data-ak="${k}" placeholder="${esc(ph)}" value="${esc(v ?? '')}">`;
    const who = v => sel('assign', [['owner', 'Record owner'], ['manager', "Owner's manager"], ...ME.users.filter(u => u.active).map(u => [u.id, u.name])], v);
    switch (a.type) {
      case 'create_task': return inp('note', 'Task text, e.g. Kick off onboarding for {{deal.title}}', a.note) + inp('due_in_days', 'Due in days', a.due_in_days ?? 1) + who(a.assign);
      case 'notify': return inp('text', 'Message, e.g. {{deal.title}} was won!', a.text) + sel('to', [['owner', 'Record owner'], ['manager', "Owner's manager"], ...ME.users.filter(u => u.active).map(u => [u.id, u.name])], a.to);
      case 'send_email': return sel('template_id', tpls.map(t => [t.id, t.name]), a.template_id);
      case 'update_deal': return sel('field', meta.deal_fields, a.field) + inp('value', 'New value', a.value);
      case 'update_contact': return sel('field', meta.contact_fields, a.field) + inp('value', 'New value (e.g. customer)', a.value);
      case 'enroll_sequence': return sel('sequence_id', seqs.map(s => [s.id, s.name]), a.sequence_id);
      case 'webhook': return inp('url', 'https://…', a.url);
      case 'slack': return inp('webhook_url', 'https://hooks.slack.com/services/…', a.webhook_url) + inp('text', 'Message, e.g. 🎉 {{owner.name}} won {{deal.title}}', a.text);
      default: return '';
    }
  };
  const edit = (w = {}) => {
    let conds = [...(w.conditions || [])], acts = [...(w.actions || [{ type: 'create_task', note: '', due_in_days: 1, assign: 'owner' }])];
    const mm = modal(w.id ? 'Edit automation' : 'New automation', `<label class="f">Name</label><input id="wn" value="${esc(w.name || '')}" placeholder="e.g. Onboarding task when a deal is won">
      <label class="f">When…</label><select id="wt">${meta.triggers.map(t => `<option value="${t}" ${w.trigger === t ? 'selected' : ''}>${esc(TR[t] || t)}</option>`).join('')}</select>
      <h4 class="mt">Only if (all conditions match)</h4><div id="wc"></div><button class="btn ghost sm" id="ac">＋ Condition</button>
      <h4 class="mt">Then…</h4><div id="wa"></div><button class="btn ghost sm" id="aa">＋ Action</button>
      <datalist id="fh">${FIELD_HINTS.map(f => `<option value="${esc(f)}">`).join('')}</datalist>
      <p class="help mt">Use merge fields like <span class="kbd">{{deal.title}}</span> <span class="kbd">{{contact.name}}</span> <span class="kbd">{{owner.name}}</span> in text.</p>
      <label class="row mt" style="gap:6px"><input type="checkbox" id="wact" ${w.active !== 0 ? 'checked' : ''}> Active</label><div class="err"></div>
      <div class="mf">${w.id ? '<button class="btn danger" id="del">Delete</button>' : ''}<span class="sp"></span><button class="btn" id="sv">Save</button></div>`, { wide: true });
    const draw = () => {
      $('#wc', mm.el).innerHTML = conds.map((c, i) => `<div class="rowed"><input list="fh" data-ci="${i}" data-k="field" value="${esc(c.field || '')}" placeholder="field, e.g. deal.value"><select data-ci="${i}" data-k="op">${meta.ops.map(o => `<option ${c.op === o ? 'selected' : ''}>${o}</option>`).join('')}</select><input data-ci="${i}" data-k="value" value="${esc(c.value ?? '')}" placeholder="value"><button class="btn link" data-rc="${i}" aria-label="Remove">✕</button></div>`).join('') || '<p class="small muted">No conditions — runs every time.</p>';
      $('#wa', mm.el).innerHTML = acts.map((a, i) => `<div class="rowed" data-ai="${i}"><select data-type="${i}">${meta.actions.map(t => `<option value="${t}" ${a.type === t ? 'selected' : ''}>${esc(AC[t] || t)}</option>`).join('')}</select>${actionFields(a)}<button class="btn link" data-ra="${i}" aria-label="Remove">✕</button></div>`).join('');
      $$('[data-ci]', mm.el).forEach(el => el.onchange = () => { conds[el.dataset.ci][el.dataset.k] = el.value; });
      $$('[data-rc]', mm.el).forEach(b => b.onclick = () => { conds.splice(b.dataset.rc, 1); draw(); });
      $$('[data-type]', mm.el).forEach(el => el.onchange = () => { acts[el.dataset.type] = { type: el.value }; draw(); });
      $$('[data-ai]', mm.el).forEach(row => $$('[data-ak]', row).forEach(el => el.onchange = () => { acts[row.dataset.ai][el.dataset.ak] = el.value; }));
      $$('[data-ra]', mm.el).forEach(b => b.onclick = () => { acts.splice(b.dataset.ra, 1); draw(); });
    };
    const collect = () => $$('[data-ai]', mm.el).forEach(row => $$('[data-ak]', row).forEach(el => { acts[row.dataset.ai][el.dataset.ak] = el.value; }));
    draw();
    $('#ac', mm.el).onclick = () => { conds.push({ field: 'deal.value', op: 'gt', value: '' }); draw(); };
    $('#aa', mm.el).onclick = () => { collect(); acts.push({ type: 'notify', to: 'owner' }); draw(); };
    $('#del', mm.el)?.addEventListener('click', async () => { if (await confirmBox('Delete this automation?', { ok: 'Delete' })) { await api('DELETE', 'workflows/' + w.id); mm.close(); render(); } });
    $('#sv', mm.el).onclick = async () => {
      collect();
      const body = { name: $('#wn', mm.el).value, trigger: $('#wt', mm.el).value, conditions: conds.filter(c => c.field), actions: acts, active: $('#wact', mm.el).checked };
      try { w.id ? await api('PATCH', 'workflows/' + w.id, body) : await api('POST', 'workflows', body); mm.close(); toast('Automation saved'); render(); } catch (x) { $('.err', mm.el).textContent = x.message; }
    };
  };
  main.innerHTML = `<div class="ph"><h2>Automations</h2>${can.manage() ? '<button class="btn" id="nw">＋ Automation</button>' : ''}</div>
    <p class="small muted mb">When something happens in the CRM, run actions automatically: create tasks, notify people, send emails, enroll in sequences, post to Slack or webhooks.</p>
    ${table({ rows, onRow: can.manage() ? edit : null, empty: 'No automations yet. Try: “When a deal is won → create an onboarding task for the owner”.', cols: [{ l: 'Name', f: w => `<b>${esc(w.name)}</b>${w.last_error ? `<div class="small err">⚠ ${esc(w.last_error)}</div>` : ''}` }, { l: 'When', f: w => esc(TR[w.trigger] || w.trigger) },
      { l: 'Then', f: w => w.actions.map(a => esc(AC[a.type] || a.type)).join(', ') }, { l: 'Runs', cls: 'n', k: 'runs' }, { l: 'Status', f: w => w.active ? '<span class="tag ok">on</span>' : '<span class="tag gray">off</span>' }] })}`;
  $('#nw')?.addEventListener('click', () => edit());
});
