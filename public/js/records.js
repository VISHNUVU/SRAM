/* Records: create/edit forms, list pages (filters, saved views, bulk, import/export), detail pages, pipeline board, tasks. */
'use strict';

// ---------------- create/edit forms
async function withDupCheck(fn, body) {
  try { return await fn(body); } catch (e) {
    if (e.status === 409 && e.data?.duplicate_id) {
      if (await confirmBox(`${e.message}. Create anyway?`, { ok: 'Create anyway', danger: false })) return fn({ ...body, force: true });
      throw new Error('Not created — duplicate');
    }
    throw e;
  }
}
const allStages = () => ME.pipelines.flatMap(p => p.stages.map(s => ({ ...s, pipeline: p.name })));
const stageOpts = pid => (ME.pipelines.find(p => p.id === Number(pid)) || ME.pipelines[0]).stages.map(s => [s.id, s.name]);
async function pickList(entity, label) { const r = await api('GET', `${entity}?limit=1000&sort=${entity === 'deals' ? 'title' : 'name'}`); return [['', '— none —'], ...r.rows.map(x => [x.id, x.name || x.title])]; }

const Forms = {
  async contact(c = {}, after) {
    const companies = await pickList('companies');
    formModal({ title: c.id ? 'Edit contact' : 'New contact', values: { owner_id: ME.user.id, lifecycle: 'lead', ...c }, cols2: true, after,
      fields: [{ k: 'name', l: 'Name', req: 1 }, { k: 'email', l: 'Email', t: 'email' }, { k: 'phone', l: 'Phone', t: 'tel' }, { k: 'title', l: 'Job title' },
        { k: 'company_id', l: 'Company', t: 'select', opts: companies }, ...(c.id ? [] : [{ k: 'company_name', l: '…or new company name' }]),
        { k: 'lifecycle', l: 'Lifecycle stage', t: 'select', opts: ['lead', 'prospect', 'customer', 'churned', 'other'] }, { k: 'source', l: 'Source' },
        { k: 'owner_id', l: 'Owner', t: 'select', opts: userOpts() }, ...customFields('contacts')],
      submit: v => withDupCheck(b => c.id ? api('PATCH', 'contacts/' + c.id, b) : api('POST', 'contacts', b), v),
      del: c.id && (() => api('DELETE', 'contacts/' + c.id).then(() => go('#/contacts'))) });
  },
  async company(c = {}, after) {
    formModal({ title: c.id ? 'Edit company' : 'New company', values: { owner_id: ME.user.id, ...c }, cols2: true, after,
      fields: [{ k: 'name', l: 'Name', req: 1 }, { k: 'website', l: 'Website', ph: 'example.com' }, { k: 'industry', l: 'Industry' }, { k: 'size', l: 'Employees', t: 'select', opts: ['', '1-10', '11-50', '51-200', '201-1000', '1000+'] },
        { k: 'phone', l: 'Phone' }, { k: 'owner_id', l: 'Account owner', t: 'select', opts: userOpts() }, { k: 'description', l: 'Description', t: 'textarea', rows: 2 }, ...customFields('companies')],
      submit: v => withDupCheck(b => c.id ? api('PATCH', 'companies/' + c.id, b) : api('POST', 'companies', b), v),
      del: c.id && (() => api('DELETE', 'companies/' + c.id).then(() => go('#/companies'))) });
  },
  async deal(d = {}, after) {
    const [contacts, companies] = await Promise.all([pickList('contacts'), pickList('companies')]);
    const pid = d.pipeline_id || ME.pipelines[0].id;
    const m = formModal({ title: d.id ? 'Edit deal' : 'New deal', values: { owner_id: ME.user.id, pipeline_id: pid, ...d }, cols2: true, after,
      fields: [{ k: 'title', l: 'Deal name', req: 1 }, { k: 'value', l: `Value (${ME.org.currency})`, t: 'number' },
        { k: 'pipeline_id', l: 'Pipeline', t: 'select', opts: ME.pipelines.map(p => [p.id, p.name]) }, { k: 'stage_id', l: 'Stage', t: 'select', opts: stageOpts(pid) },
        { k: 'contact_id', l: 'Contact', t: 'select', opts: contacts }, { k: 'company_id', l: 'Company', t: 'select', opts: companies },
        { k: 'close_date', l: 'Expected close', t: 'date' }, { k: 'owner_id', l: 'Owner', t: 'select', opts: userOpts() }, ...customFields('deals')],
      submit: v => d.id ? api('PATCH', 'deals/' + d.id, v) : api('POST', 'deals', v),
      del: d.id && (() => api('DELETE', 'deals/' + d.id).then(() => go('#/pipeline'))) });
    const ps = $('[name=pipeline_id]', m.el), ss = $('[name=stage_id]', m.el);
    ps.onchange = () => { ss.innerHTML = stageOpts(ps.value).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join(''); };
  },
  async task(a = {}, after) {
    const type = a.type || 'task';
    const fields = [{ k: 'type', l: 'Type', t: 'select', opts: [['task', 'Task'], ['call', 'Call'], ['meeting', 'Meeting'], ['email', 'Email (logged)'], ['note', 'Note']] },
      { k: 'subject', l: 'Subject' }, { k: 'note', l: 'Notes', t: 'textarea', rows: 3 },
      { k: 'due_date', l: 'Due date', t: 'date' }, { k: 'start_at', l: 'Meeting / call time', t: 'datetime' }, { k: 'duration_min', l: 'Duration (minutes)', t: 'number' },
      { k: 'outcome', l: 'Outcome', t: 'select', opts: ['', 'Connected', 'Left voicemail', 'No answer', 'Wrong number', 'Meeting booked', 'Not interested'] },
      { k: 'owner_id', l: 'Assigned to', t: 'select', opts: userOpts() }];
    if (a.id) fields.push({ k: 'done', l: 'Completed', t: 'checkbox' });
    const m = formModal({ title: a.id ? 'Edit activity' : 'New activity', values: { owner_id: ME.user.id, type, due_date: a.id ? a.due_date : (type === 'task' ? fmt.today() : ''), ...a }, cols2: true, after,
      fields, submit: v => { for (const k of ['deal_id', 'contact_id', 'company_id']) if (a[k] && !a.id) v[k] = a[k]; return a.id ? api('PATCH', 'activities/' + a.id, v) : api('POST', 'activities', v); },
      del: a.id && (() => api('DELETE', 'activities/' + a.id)) });
    const sync = () => { const t = $('[name=type]', m.el).value; $('[name=start_at]', m.el).closest('div').classList.toggle('hide', !['meeting', 'call'].includes(t)); $('[name=duration_min]', m.el).closest('div').classList.toggle('hide', !['meeting', 'call'].includes(t)); $('[name=outcome]', m.el).closest('div').classList.toggle('hide', t !== 'call'); };
    $('[name=type]', m.el).onchange = sync; sync();
  },
};

// Lost-reason prompt when moving a deal to a Lost stage.
function lostReason() {
  return new Promise(res => {
    const m = formModal({ title: 'Why was this deal lost?', fields: [{ k: 'lost_reason', l: 'Reason', t: 'select', opts: ME.org.lost_reasons, req: 1 }], submitLabel: 'Mark as lost', submit: v => { res(v.lost_reason); } });
    $('[data-cancel]', m.el).addEventListener('click', () => res(null)); $('[data-x]', m.el).addEventListener('click', () => res(null));
  });
}
async function moveDeal(deal, stageId) {
  const st = allStages().find(s => s.id === Number(stageId)); const body = { stage_id: Number(stageId) };
  if (st.kind === 'lost') { const r = await lostReason(); if (!r) return false; body.lost_reason = r; }
  await api('PATCH', 'deals/' + deal.id, body);
  if (st.kind === 'won') toast('🎉 Deal won!'); return true;
}

// ---------------- generic list page
const LISTS = {
  contacts: { title: 'Contacts', create: () => Forms.contact({}, r => go('#/contacts/' + r.id)),
    filters: () => [['q', 'search', 'Search name, email, company'], ['owner_id', 'select', userOpts('Any owner')], ['lifecycle', 'select', [['', 'Any stage'], 'lead', 'prospect', 'customer', 'churned', 'other']], ['min_score', 'select', [['', 'Any score'], ['10', 'Score ≥ 10'], ['25', 'Score ≥ 25'], ['50', 'Score ≥ 50']]]],
    cols: () => [{ l: 'Name', f: r => `<b>${esc(r.name)}</b>${r.unsubscribed ? ' <span class="tag gray">unsubscribed</span>' : ''}<div class="small muted">${esc(r.title || '')}</div>` }, { l: 'Company', k: 'company_name' }, { l: 'Email', k: 'email' },
      { l: 'Phone', k: 'phone', cls: 'hide-sm' }, { l: 'Stage', f: r => lifecycleTag(r.lifecycle) }, { l: 'Score', cls: 'n', f: r => r.lead_score }, { l: 'Owner', f: r => avatar(r.owner_id) }],
    bulk: [['assign', 'Assign to…'], ['lifecycle', 'Set stage…'], ['enroll', 'Add to sequence…'], ['delete', 'Delete']], sorts: [['', 'Newest'], ['name', 'Name'], ['-lead_score', 'Lead score'], ['-updated_at', 'Recently updated']] },
  companies: { title: 'Companies', create: () => Forms.company({}, r => go('#/companies/' + r.id)),
    filters: () => [['q', 'search', 'Search companies'], ['owner_id', 'select', userOpts('Any owner')], ['size', 'select', [['', 'Any size'], '1-10', '11-50', '51-200', '201-1000', '1000+']]],
    cols: () => [{ l: 'Name', f: r => `<b>${esc(r.name)}</b><div class="small muted">${esc(r.domain || '')}</div>` }, { l: 'Industry', k: 'industry' }, { l: 'Size', k: 'size', cls: 'hide-sm' }, { l: 'Contacts', k: 'contact_count', cls: 'n' }, { l: 'Open pipeline', cls: 'n', f: r => fmt.money(r.open_value) }, { l: 'Owner', f: r => avatar(r.owner_id) }],
    bulk: [['assign', 'Assign to…'], ['delete', 'Delete']], sorts: [['', 'Newest'], ['name', 'Name']] },
  deals: { title: 'Deals', create: () => Forms.deal({}, r => go('#/deals/' + r.id)),
    filters: () => [['q', 'search', 'Search deals'], ['owner_id', 'select', userOpts('Any owner')], ['pipeline_id', 'select', [['', 'Any pipeline'], ...ME.pipelines.map(p => [p.id, p.name])]], ['status', 'select', [['', 'Any status'], ['open', 'Open'], ['won', 'Won'], ['lost', 'Lost']]], ['close_from', 'date', 'Closing from'], ['close_to', 'date', 'Closing to']],
    cols: () => [{ l: 'Deal', f: r => `<b>${esc(r.title)}</b><div class="small muted">${esc(r.company_name || r.contact_name || '')}</div>` }, { l: 'Stage', f: r => stageTag(r.stage_name, r.stage_kind) }, { l: 'Value', cls: 'n', f: r => fmt.money(r.value) },
      { l: 'Close', f: r => `<span class="${r.stage_kind === 'open' && r.close_date && r.close_date < fmt.today() ? 'err' : ''}">${fmt.date(r.close_date)}</span>` }, { l: 'Pipeline', k: 'pipeline_name', cls: 'hide-sm' }, { l: 'Owner', f: r => avatar(r.owner_id) }],
    bulk: [['assign', 'Assign to…'], ['stage', 'Move to stage…'], ['delete', 'Delete']], sorts: [['', 'Newest'], ['-value', 'Value'], ['close_date', 'Close date'], ['stage', 'Stage']] },
};
async function listPage(main, entity, query) {
  const L = LISTS[entity], filt = L.filters();
  const views = ME.views.filter(v => v.entity === entity);
  main.innerHTML = `<div class="ph"><h2>${L.title}</h2>
    ${views.length ? `<select id="views" style="width:auto"><option value="">Saved views…</option>${views.map(v => `<option value="${v.id}">${esc(v.name)}${v.shared ? ' (shared)' : ''}</option>`).join('')}</select>` : ''}
    <button class="btn ghost" id="saveView">Save view</button>
    ${entity === 'deals' ? '<a class="btn ghost" href="#/pipeline">Board view</a>' : ''}
    ${entity !== 'deals' ? `<a class="btn ghost" href="#/leads/duplicates">Duplicates</a>` : ''}
    <button class="btn ghost" id="imp">Import</button><a class="btn ghost" id="exp">Export</a><button class="btn" id="new">＋ New</button></div>
    <div class="filters">${filt.map(([k, t, o]) => t === 'select' ? `<select data-f="${k}" aria-label="${k}">${o.map(x => { const [v, l] = Array.isArray(x) ? x : [x, x]; return `<option value="${esc(v)}" ${String(query.get(k) ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`
      : `<input data-f="${k}" type="${t}" placeholder="${esc(o)}" aria-label="${esc(o)}" value="${esc(query.get(k) || '')}" ${t === 'date' ? `title="${esc(o)}"` : ''}>`).join('')}
      <select data-f="sort" aria-label="Sort">${L.sorts.map(([v, l]) => `<option value="${v}" ${query.get('sort') === v ? 'selected' : ''}>Sort: ${l}</option>`).join('')}</select>
      <label class="row small" style="flex:0 0 auto;gap:5px"><input type="checkbox" data-f="mine" ${query.get('mine') ? 'checked' : ''}> Mine</label></div>
    <div id="bulk"></div><div id="list"></div><div id="more" class="mt"></div>`;
  const state = () => { const o = {}; $$('[data-f]', main).forEach(el => { const v = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value; if (v) o[el.dataset.f] = v; }); return o; };
  let rows = [], total = 0;
  const load = async (append = false) => {
    const s = state(); const r = await api('GET', `${entity}?${qs({ ...s, limit: 100, offset: append ? rows.length : 0 })}`);
    rows = append ? rows.concat(r.rows) : r.rows; total = r.total;
    $('#list', main).innerHTML = table({ rows, cols: L.cols(), select: true, id: 'lt', onRow: (x, e) => { const h = `#/${entity}/${x.id}`; if (e.metaKey || e.ctrlKey) open(h); else go(h); }, empty: Object.keys(s).length ? 'No matches for these filters.' : `No ${L.title.toLowerCase()} yet — create one or import a CSV.` });
    $('#more', main).innerHTML = `<span class="muted small">${rows.length} of ${total}</span> ${rows.length < total ? '<button class="btn ghost sm" id="lm">Load more</button>' : ''}`;
    $('#lm', main)?.addEventListener('click', () => load(true));
    $('#exp', main).href = `/api/export/${entity}?${qs(s)}`;
    setTimeout(() => $('#lt')?.addEventListener('selchange', bulkBar));
    bulkBar();
  };
  const bulkBar = () => {
    const ids = $('#lt') ? selected($('#lt')) : [];
    $('#bulk', main).innerHTML = ids.length ? `<div class="bulk"><b>${ids.length} selected</b>${L.bulk.map(([a, l]) => `<button class="btn ${a === 'delete' ? 'danger' : 'ghost'} sm" data-b="${a}">${l}</button>`).join('')}</div>` : '';
    $$('[data-b]', main).forEach(b => b.onclick = () => bulk(b.dataset.b, ids));
  };
  const bulk = async (action, ids) => {
    let value;
    if (action === 'delete') { if (!(await confirmBox(`Delete ${ids.length} record(s)?`, { ok: 'Delete' }))) return; }
    else {
      const opts = action === 'assign' ? userOpts() : action === 'lifecycle' ? ['lead', 'prospect', 'customer', 'churned', 'other'] : action === 'stage' ? allStages().map(s => [s.id, `${s.pipeline} › ${s.name}`])
        : (await api('GET', 'sequences').catch(e => { fail(e); return []; })).filter(s => s.active).map(s => [s.id, s.name]);
      if (!opts.length) return toast('Create a sequence first', 'bad');
      value = await new Promise(res => formModal({ title: 'Bulk update', fields: [{ k: 'v', l: 'Choose', t: 'select', opts, req: 1 }], submitLabel: 'Apply', submit: v => { res(v.v); } }));
    }
    const r = await api('POST', `${entity}/bulk`, { ids, action, value });
    toast(`${r.updated} updated${r.errors.length ? `, ${r.errors.length} failed: ${r.errors[0].error}` : ''}`, r.errors.length ? 'bad' : 'ok'); load();
  };
  let t; $$('[data-f]', main).forEach(el => el.addEventListener(el.type === 'search' ? 'input' : 'change', () => { clearTimeout(t); t = setTimeout(() => { history.replaceState(null, '', `#/${entity}?${qs(state())}`); load(); }, 250); }));
  $('#new', main).onclick = L.create;
  $('#imp', main).onclick = () => importWizard(entity, load);
  $('#views', main)?.addEventListener('change', e => { const v = views.find(x => x.id === Number(e.target.value)); if (v) go(`#/${entity}?${v.query}`); });
  $('#saveView', main).onclick = () => formModal({ title: 'Save current filters as a view', fields: [{ k: 'name', l: 'View name', req: 1 }, { k: 'shared', l: 'Share with the team', t: 'checkbox' }],
    submit: async v => { await api('POST', 'views', { ...v, entity, query: qs(state()) }); ME.views = await api('GET', 'views'); toast('View saved'); }, after: () => listPage(main, entity, new URLSearchParams(qs(state()))) });
  await load();
}

// ---------------- CSV import wizard (client-side parse preview → server import)
function parseCsvClient(text) {
  const rows = []; let row = [], f = '', q = false; text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; } else f += c; }
  if (f !== '' || row.length) { row.push(f); rows.push(row); } return rows.filter(r => r.some(c => c.trim()));
}
async function importWizard(entity, done) {
  if (entity === 'activities') return;
  const fields = await api('GET', `import/${entity}/fields`);
  const m = modal(`Import ${entity}`, `<p class="muted small">Upload a CSV with a header row. You'll map columns next.</p><input type="file" accept=".csv,text/csv" id="csvf"><div id="map"></div>`, { wide: true });
  $('#csvf', m.el).onchange = async e => {
    const file = e.target.files[0]; if (!file) return; if (file.size > 15e6) return toast('File too large (max 15 MB)', 'bad');
    const text = await file.text(), rows = parseCsvClient(text), head = rows[0] || [];
    const guess = h => { const n = h.toLowerCase().replace(/[^a-z]/g, ''); return fields.find(f => f.replace(/[^a-z]/g, '') === n) || { fullname: 'name', firstname: 'first_name', lastname: 'last_name', emailaddress: 'email', mobile: 'phone', jobtitle: 'title', company: 'company', organization: 'company', amount: 'value', dealname: 'title', owner: 'owner_email' }[n] || ''; };
    $('#map', m.el).innerHTML = `<p><b>${rows.length - 1}</b> rows found.</p><div class="tw"><table class="t"><tr><th>CSV column</th><th>Example</th><th>Maps to</th></tr>${head.map((h, i) => `<tr><td>${esc(h)}</td><td class="muted small">${esc((rows[1] || [])[i] || '')}</td>
      <td><select data-col="${i}"><option value="">— skip —</option>${fields.map(f => `<option ${guess(h) === f ? 'selected' : ''}>${f}</option>`).join('')}</select></td></tr>`).join('')}</table></div>
      <label class="f">If a record already exists (matched by ${entity === 'contacts' ? 'email' : entity === 'companies' ? 'name' : '—'})</label><select id="mode"><option value="skip">Skip it</option><option value="update">Update it with non-empty values</option><option value="create">Create a duplicate anyway</option></select>
      <div class="err" id="ie"></div><div class="mf"><span class="sp"></span><button class="btn" id="go">Import</button></div>`;
    $('#go', m.el).onclick = async () => {
      const mapping = {}; $$('[data-col]', m.el).forEach(s => { if (s.value) mapping[s.dataset.col] = s.value; });
      if (!Object.keys(mapping).length) return ($('#ie', m.el).textContent = 'Map at least one column');
      $('#go', m.el).disabled = true; $('#go', m.el).textContent = 'Importing…';
      try {
        const r = await api('POST', `import/${entity}`, { csv: text, mapping, mode: $('#mode', m.el).value });
        $('#map', m.el).innerHTML = `<p>✅ <b>${r.created}</b> created, <b>${r.updated}</b> updated, <b>${r.skipped}</b> skipped${r.errors.length ? `, <b class="err">${r.errors.length}</b> errors` : ''}.</p>
          ${r.errors.length ? `<div class="tw" style="max-height:200px"><table class="t">${r.errors.slice(0, 100).map(x => `<tr><td>Row ${x.row}</td><td>${esc(x.error)}</td></tr>`).join('')}</table></div>` : ''}`;
        done();
      } catch (x) { $('#ie', m.el).textContent = x.message; $('#go', m.el).disabled = false; $('#go', m.el).textContent = 'Import'; }
    };
  };
}

route(/^\/contacts$/, (m, _, q) => listPage(m, 'contacts', q));
route(/^\/companies$/, (m, _, q) => listPage(m, 'companies', q));
route(/^\/deals$/, (m, _, q) => listPage(m, 'deals', q));

// ---------------- detail pages
const TL_ICON = { task: icon('tasks', 15), call: icon('phone', 15), meeting: icon('calendar', 15), email: icon('mail', 15), note: icon('note', 15), stage: icon('arrow', 15), change: icon('layers', 15) };
function timelineHtml(items) {
  if (!items.length) return '<div class="empty">No activity yet. Log a note, call or email above.</div>';
  return `<ul class="tl">${items.map(t => {
    if (t.kind === 'email') return `<li><div class="ic ${t.direction === 'in' ? 'in' : 'out'}">${icon(t.direction === 'in' ? 'inbox' : 'send', 15)}</div><div class="body"><div class="row"><b class="grow">${esc(t.subject)}</b><span class="small muted">${fmt.rel(t.at)}</span></div>
      <div class="small muted">${t.direction === 'in' ? 'Received from ' + esc(t.from_addr) : 'Sent to ' + esc(t.to_addr)} · <span class="tag ${t.status === 'failed' ? 'bad' : t.status === 'queued' ? 'warn' : 'gray'}">${esc(t.status)}</span>${t.open_count ? ` · 👁 opened ${t.open_count}×` : ''}</div>
      <details><summary class="small muted">Show message</summary><div class="txt">${esc(t.body)}</div></details></div></li>`;
    if (t.kind === 'stage') return `<li><div class="ic stage">${TL_ICON.stage}</div><div class="body"><div class="row"><span class="grow">${esc(t.user_name || 'System')} moved stage ${t.from_name ? `${esc(t.from_name)} → ` : 'to '}<b>${esc(t.to_name)}</b></span><span class="small muted">${fmt.rel(t.at)}</span></div></div></li>`;
    if (t.kind === 'change') return `<li><div class="ic">${TL_ICON.change}</div><div class="body"><div class="row"><span class="grow small">${esc(t.user_name || 'System')} ${t.action === 'create' ? 'created this record' : 'updated ' + Object.keys(t.detail || {}).filter(k => !['enriched'].includes(k)).map(k => `<b>${esc(k.replace(/_id$/, '').replace(/_/g, ' '))}</b>`).join(', ')}</span><span class="small muted">${fmt.rel(t.at)}</span></div></div></li>`;
    return `<li><div class="ic t-${t.type}">${TL_ICON[t.type] || '•'}</div><div class="body"><div class="row"><b class="grow" style="${t.done && t.type === 'task' ? 'text-decoration:line-through;opacity:.7' : ''}">${esc(t.subject || t.type[0].toUpperCase() + t.type.slice(1))}</b>
      <span class="small muted">${t.start_at ? fmt.dt(t.start_at) : t.due_date ? 'due ' + fmt.date(t.due_date) : fmt.rel(t.created_at)}</span><button class="btn link small" data-act="${t.id}">Edit</button></div>
      <div class="small muted">${esc(t.user_name || '')}${t.outcome ? ' · ' + esc(t.outcome) : ''}${t.duration_min ? ` · ${t.duration_min} min` : ''}</div>${t.note ? `<div class="txt">${esc(t.note)}</div>` : ''}</div></li>`;
  }).join('')}</ul>`;
}
function bindTimeline(el, items, reload) { $$('[data-act]', el).forEach(b => b.onclick = () => Forms.task(items.find(x => x.kind === 'activity' && x.id === Number(b.dataset.act)), reload)); }

function composer(ctx, reload) { // ctx: {contact_id, deal_id, company_id, contact}
  const id = 'cmp' + Math.random().toString(36).slice(2);
  setTimeout(() => {
    const el = document.getElementById(id); if (!el) return;
    const show = tab => {
      $$('.tabs a', el).forEach(a => a.classList.toggle('on', a.dataset.t === tab));
      const body = $('.cb', el);
      if (tab === 'email') {
        if (!ctx.contact?.email) { body.innerHTML = '<p class="muted">Add an email address to this contact to send email.</p>'; return; }
        body.innerHTML = `<div class="row"><select id="${id}tpl" style="flex:1"><option value="">No template</option></select>${can.pro('ai') && ME.features.ai ? `<button class="btn ghost sm" id="${id}ai">✨ Draft with AI</button>` : ''}</div>
          <input id="${id}s" placeholder="Subject" class="mt"><textarea id="${id}b" rows="6" class="mt" placeholder="Write your email…"></textarea>
          <div class="row mt"><span class="small muted grow">To ${esc(ctx.contact.email)} · sent ${ME.user.gmail_connected ? 'from your Gmail' : ME.features.mail ? 'via ' + esc(ME.features.mail_provider) : '(dev: logged, not delivered — configure a mail provider)'} · opens tracked</span><button class="btn" id="${id}send">Send</button></div>`;
        api('GET', 'templates').then(ts => { $(`#${id}tpl`).innerHTML += ts.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join(''); $(`#${id}tpl`).onchange = e => { const t = ts.find(x => x.id === Number(e.target.value)); if (t) { $(`#${id}s`).value = t.subject; $(`#${id}b`).value = t.body; } }; });
        $(`#${id}ai`)?.addEventListener('click', async e => {
          const instr = prompt('What should the email do? (e.g. "follow up on the demo, propose a call next week")'); if (instr === null) return;
          e.target.disabled = true; e.target.textContent = '✨ Drafting…';
          try { const d = await api('POST', 'ai/draft-email', { contact_id: ctx.contact.id, deal_id: ctx.deal_id, instructions: instr }); $(`#${id}s`).value = d.subject; $(`#${id}b`).value = d.body; } catch (x) { fail(x); } finally { e.target.disabled = false; e.target.textContent = '✨ Draft with AI'; }
        });
        $(`#${id}send`).onclick = async e => {
          const tplId = $(`#${id}tpl`).value, subject = $(`#${id}s`).value, b = $(`#${id}b`).value;
          if (!subject.trim() || !b.trim()) return toast('Add a subject and message', 'bad');
          e.target.disabled = true;
          try { await api('POST', 'emails/send', { contact_id: ctx.contact.id, deal_id: ctx.deal_id, template_id: tplId || undefined, subject, body: b }); toast('Email sent'); setTimeout(reload, 400); } catch (x) { fail(x); e.target.disabled = false; }
        };
        return;
      }
      const isCall = tab === 'call', isMeet = tab === 'meeting', isTask = tab === 'task';
      body.innerHTML = `${isTask || isMeet ? `<input id="${id}sub" placeholder="${isTask ? 'Task, e.g. Send pricing' : 'Meeting title'}">` : ''}
        <textarea id="${id}n" rows="${isCall ? 4 : 3}" class="${isTask || isMeet ? 'mt' : ''}" placeholder="${isCall ? 'Call notes…' : tab === 'note' ? 'Write a note…' : 'Details (optional)'}"></textarea>
        <div class="row mt">${isTask ? `<input type="date" id="${id}d" value="${fmt.today()}" style="width:auto" aria-label="Due">` : ''}${isMeet || isCall ? `<input type="datetime-local" id="${id}dt" style="width:auto" aria-label="When" value="${fmt.localInput(new Date().toISOString())}">` : ''}
        ${isCall ? `<select id="${id}o" style="width:auto"><option>Connected</option><option>Left voicemail</option><option>No answer</option><option>Meeting booked</option><option>Not interested</option></select>` : ''}
        ${isCall && ctx.contact?.phone ? `<a class="btn ghost sm" href="tel:${esc(ctx.contact.phone)}">${icon('phone', 14)} ${esc(ctx.contact.phone)}</a>${ME.features.twilio ? `<button class="btn ghost sm" id="${id}dial">Call via browser bridge</button>` : ''}` : ''}
        ${isCall && can.pro('ai') && ME.features.ai ? `<button class="btn ghost sm" id="${id}sum">✨ Clean up notes</button>` : ''}
        <span class="grow"></span><button class="btn" id="${id}save">${isTask ? 'Add task' : isMeet ? 'Schedule' : isCall ? 'Log call' : 'Save note'}</button></div>`;
      $(`#${id}dial`)?.addEventListener('click', async () => { try { await api('POST', 'calls/dial', { contact_id: ctx.contact.id, deal_id: ctx.deal_id }); toast('Calling your phone — answer to connect'); } catch (x) { fail(x); } });
      $(`#${id}sum`)?.addEventListener('click', async e => { const n = $(`#${id}n`); if (!n.value.trim()) return; e.target.disabled = true; try { const r = await api('POST', 'ai/call-summary', { notes: n.value }); n.value = r.summary + (r.action_items.length ? '\n\nAction items:\n- ' + r.action_items.join('\n- ') : ''); } catch (x) { fail(x); } finally { e.target.disabled = false; } });
      $(`#${id}save`).onclick = async e => {
        const body = { type: tab, note: $(`#${id}n`).value, subject: $(`#${id}sub`)?.value || (isCall ? `Call with ${ctx.contact?.name || ''}`.trim() : undefined), contact_id: ctx.contact_id, deal_id: ctx.deal_id, company_id: ctx.company_id };
        if (isTask) body.due_date = $(`#${id}d`).value; if (isMeet || isCall) body.start_at = $(`#${id}dt`).value ? new Date($(`#${id}dt`).value).toISOString() : undefined;
        if (isCall) { body.outcome = $(`#${id}o`).value; body.done = true; } if (tab === 'note') body.done = true;
        if (!body.note?.trim() && !body.subject?.trim()) return toast('Write something first', 'bad');
        e.target.disabled = true; try { await api('POST', 'activities', body); toast('Saved'); reload(); } catch (x) { fail(x); e.target.disabled = false; }
      };
    };
    $$('.tabs a', el).forEach(a => a.onclick = e => { e.preventDefault(); show(a.dataset.t); });
    show('note');
  });
  return `<div class="card composer" id="${id}"><div class="tabs">${[['note', 'note', 'Note'], ['email', 'mail', 'Email'], ['call', 'phone', 'Call'], ['task', 'tasks', 'Task'], ['meeting', 'calendar', 'Meeting']].map(([t, i, l]) => `<a href="#" data-t="${t}">${icon(i, 15)} ${l}</a>`).join('')}</div><div class="cb"></div></div>`;
}
function aiPanel(entity, id) {
  if (!ME.features.ai || !can.pro('ai')) return '';
  const pid = 'ai' + id;
  setTimeout(() => $('#' + pid)?.querySelector('button').addEventListener('click', async e => {
    const box = $('#' + pid); e.target.disabled = true; e.target.textContent = '✨ Thinking…';
    try {
      const r = await api('POST', 'ai/summary', { entity, id });
      box.innerHTML = `<div class="row"><b class="grow">✨ AI summary</b><span class="tag ${r.risk === 'high' ? 'bad' : r.risk === 'medium' ? 'warn' : 'ok'}">${esc(r.risk)} risk</span></div><p>${esc(r.summary)}</p><p class="small muted">${esc(r.risk_reason)}</p><b class="small">Next steps</b><ul>${r.next_steps.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`;
    } catch (x) { fail(x); e.target.disabled = false; e.target.textContent = '✨ Summarize & suggest next steps'; }
  }));
  return `<div class="ai" id="${pid}"><button class="btn ghost sm">✨ Summarize & suggest next steps</button></div>`;
}
function filesCard(entity, id, files, reload) {
  const fid = 'fu' + Math.random().toString(36).slice(2);
  setTimeout(() => {
    $('#' + fid)?.addEventListener('change', async e => {
      for (const f of e.target.files) { if (f.size > 15e6) { toast(`${f.name} is larger than 15 MB`, 'bad'); continue; } try { await api('POST', `files?entity=${entity}&id=${id}`, null, { raw: f, headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) } }); } catch (x) { fail(x); } }
      reload();
    });
    $$('[data-delfile]').forEach(b => b.onclick = async () => { if (await confirmBox('Delete this file?', { ok: 'Delete' })) { await api('DELETE', 'files/' + b.dataset.delfile); reload(); } });
  });
  return `<div class="card"><div class="row"><h3 class="grow">Files</h3><label class="btn ghost sm">Upload<input type="file" id="${fid}" multiple hidden></label></div>
    ${files.length ? files.map(f => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--bd2)"><a class="grow" href="/api/files/${f.id}" download>${icon('quote', 15)} ${esc(f.name)}</a><span class="small muted">${(f.size / 1024).toFixed(0)} KB</span><button class="btn link small" data-delfile="${f.id}" aria-label="Delete">✕</button></div>`).join('') : '<p class="muted small">No files yet.</p>'}</div>`;
}
function fieldsKv(entity, r, rows) {
  const defs = ME.fields[entity] || [];
  return `<dl class="kv">${rows.filter(([, v]) => v !== undefined).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v || '<span class="muted">—</span>'}</dd>`).join('')}
    ${defs.map(d => `<dt>${esc(d.label)}</dt><dd>${customValue(d, r.custom?.[d.key]) || '<span class="muted">—</span>'}</dd>`).join('')}</dl>`;
}

route(/^\/contacts\/(\d+)$/, async (main, m) => {
  const load = async () => {
    const c = await api('GET', 'contacts/' + m[1]);
    main.innerHTML = `<div class="ph"><div class="grow"><a href="#/contacts" class="small">← Contacts</a><h2>${esc(c.name)} ${lifecycleTag(c.lifecycle)}</h2><div class="muted">${esc([c.title, c.company_name].filter(Boolean).join(' at '))}</div></div>
      ${c.email ? `<a class="btn ghost icon-only" href="mailto:${esc(c.email)}" aria-label="Email">${icon('mail', 16)}</a>` : ''}${c.phone ? `<a class="btn ghost icon-only" href="tel:${esc(c.phone)}" aria-label="Call">${icon('phone', 16)}</a>` : ''}
      ${can.pro('sequences') ? '<button class="btn ghost" id="enr">Add to sequence</button>' : ''}<button class="btn ghost" id="nd">＋ Deal</button><button class="btn" id="ed">Edit</button></div>
      <div class="detail"><div class="stack">
        <div class="card">${fieldsKv('contacts', c, [['Email', c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>${c.unsubscribed ? ' <span class="tag gray">unsubscribed</span>' : ''}` : ''], ['Phone', esc(c.phone)], ['Company', c.company_id ? `<a href="#/companies/${c.company_id}">${esc(c.company_name)}</a>` : ''],
          ['Owner', esc(c.owner_name)], ['Lead score', `<b>${c.lead_score}</b>`], ['Source', esc(c.source)], ['Created', fmt.date(c.created_at)]])}</div>
        <div class="card"><h3>Deals (${c.deals.length})</h3>${c.deals.map(d => `<div class="row" style="padding:5px 0"><a class="grow" href="#/deals/${d.id}">${esc(d.title)}</a>${stageTag(d.stage_name, d.stage_kind)}<span class="num">${fmt.money(d.value)}</span></div>`).join('') || '<p class="muted small">No deals yet.</p>'}</div>
        ${c.enrollments.length ? `<div class="card"><h3>Sequences</h3>${c.enrollments.map(e => `<div class="row" style="padding:4px 0"><span class="grow">${esc(e.sequence_name)}</span><span class="tag ${e.status === 'active' ? '' : 'gray'}">${esc(e.status)} · step ${e.step}</span>${e.status === 'active' ? `<button class="btn link small" data-stop="${e.id}">Stop</button>` : ''}</div>`).join('')}</div>` : ''}
        ${filesCard('contacts', c.id, c.files, load)}
      </div><div class="stack">${aiPanel('contacts', c.id)}${composer({ contact_id: c.id, contact: c }, load)}<div class="card"><h3>Timeline</h3><div id="tl">${timelineHtml(c.timeline)}</div></div></div></div>`;
    bindTimeline(main, c.timeline, load);
    $('#ed').onclick = () => Forms.contact(c, load);
    $('#nd').onclick = () => Forms.deal({ contact_id: c.id, company_id: c.company_id, title: `${c.company_name || c.name} deal` }, r => go('#/deals/' + r.id));
    $$('[data-stop]').forEach(b => b.onclick = async () => { await api('POST', `enrollments/${b.dataset.stop}/stop`); load(); });
    $('#enr')?.addEventListener('click', async () => {
      const seqs = (await api('GET', 'sequences')).filter(s => s.active); if (!seqs.length) return toast('Create a sequence under Email → Sequences first', 'bad');
      formModal({ title: 'Add to sequence', fields: [{ k: 's', l: 'Sequence', t: 'select', opts: seqs.map(s => [s.id, s.name]), req: 1 }], submitLabel: 'Enroll',
        submit: async v => { const r = await api('POST', `sequences/${v.s}/enroll`, { contact_ids: [c.id] }); if (r.errors.length) throw new Error(r.errors[0].error); toast('Enrolled'); }, after: load });
    });
  };
  await load();
});
route(/^\/companies\/(\d+)$/, async (main, m) => {
  const load = async () => {
    const c = await api('GET', 'companies/' + m[1]);
    main.innerHTML = `<div class="ph"><div class="grow"><a href="#/companies" class="small">← Companies</a><h2>${esc(c.name)}</h2><div class="muted">${esc([c.industry, c.size && c.size + ' employees'].filter(Boolean).join(' · '))}</div></div>
      <button class="btn ghost" id="enrich">${icon('sparkles', 16)} Enrich</button><button class="btn ghost" id="nc">＋ Contact</button><button class="btn ghost" id="nd">＋ Deal</button><button class="btn" id="ed">Edit</button></div>
      <div class="detail"><div class="stack"><div class="card">${fieldsKv('companies', c, [['Website', c.website ? `<a href="${esc(/^https?:/.test(c.website) ? c.website : 'https://' + c.website)}" target="_blank" rel="noopener noreferrer">${esc(c.domain || c.website)}</a>` : ''], ['Phone', esc(c.phone)], ['Owner', esc(c.owner_name)], ['About', esc(c.description)], ['Open pipeline', fmt.money(c.open_value)]])}</div>
        <div class="card"><h3>People (${c.contacts.length})</h3>${c.contacts.map(p => `<div class="row" style="padding:5px 0"><a class="grow" href="#/contacts/${p.id}">${esc(p.name)}</a><span class="small muted">${esc(p.title || '')}</span></div>`).join('') || '<p class="muted small">No contacts yet.</p>'}</div>
        <div class="card"><h3>Deals (${c.deals.length})</h3>${c.deals.map(d => `<div class="row" style="padding:5px 0"><a class="grow" href="#/deals/${d.id}">${esc(d.title)}</a>${stageTag(d.stage_name, d.stage_kind)}<span class="num">${fmt.money(d.value)}</span></div>`).join('') || '<p class="muted small">No deals yet.</p>'}</div>
        ${filesCard('companies', c.id, c.files, load)}</div>
      <div class="stack">${aiPanel('companies', c.id)}${composer({ company_id: c.id }, load)}<div class="card"><h3>Timeline</h3>${timelineHtml(c.timeline)}</div></div></div>`;
    bindTimeline(main, c.timeline, load);
    $('#ed').onclick = () => Forms.company(c, load);
    $('#nc').onclick = () => Forms.contact({ company_id: c.id }, load);
    $('#nd').onclick = () => Forms.deal({ company_id: c.id, title: c.name + ' deal' }, r => go('#/deals/' + r.id));
    $('#enrich').onclick = async e => { e.target.disabled = true; try { const r = await api('POST', `companies/${c.id}/enrich`); toast(r.updated.length > 2 ? 'Company enriched' : 'Fetched site — nothing new to add'); load(); } catch (x) { fail(x); e.target.disabled = false; } };
  };
  await load();
});
route(/^\/deals\/(\d+)$/, async (main, m) => {
  const load = async () => {
    const d = await api('GET', 'deals/' + m[1]);
    const cur = d.stages.find(s => s.id === d.stage_id);
    main.innerHTML = `<div class="ph"><div class="grow"><a href="#/pipeline?p=${d.pipeline_id}" class="small">← ${esc(d.pipeline_name)}</a><h2>${esc(d.title)}</h2><div class="muted"><b class="num" style="color:var(--tx)">${fmt.money(d.value)}</b> · ${stageTag(d.stage_name, d.stage_kind)} · ${d.probability}% · close ${fmt.date(d.close_date) || '—'}</div></div>
      ${can.pro('quotes') ? '<button class="btn ghost" id="nq">＋ Quote</button>' : ''}<button class="btn" id="ed">Edit</button></div>
      <div class="stages" role="group" aria-label="Stage">${d.stages.map(s => `<button data-s="${s.id}" class="${s.kind} ${s.id === d.stage_id ? 'cur' : cur.kind === 'open' && s.kind === 'open' && s.position < cur.position ? 'done' : ''}" title="${esc(s.name)} · ${s.probability}%">${esc(s.name)}</button>`).join('')}</div>
      ${d.lost_reason ? `<p class="err">Lost reason: ${esc(d.lost_reason)}</p>` : ''}
      <div class="detail"><div class="stack"><div class="card">${fieldsKv('deals', d, [['Contact', d.contact_id ? `<a href="#/contacts/${d.contact_id}">${esc(d.contact_name)}</a>` : ''], ['Company', d.company_id ? `<a href="#/companies/${d.company_id}">${esc(d.company_name)}</a>` : ''],
        ['Owner', esc(d.owner_name)], ['Weighted', fmt.money(d.value * d.probability / 100)], ['Created', fmt.date(d.created_at)], ['Closed', d.closed_at ? fmt.date(d.closed_at) : undefined]])}</div>
        ${can.pro('quotes') ? `<div class="card"><h3>Quotes</h3>${d.quotes.map(q => `<div class="row" style="padding:5px 0"><a class="grow" href="#/quotes/${q.id}">${esc(q.number)}</a><span class="tag ${q.status === 'accepted' ? 'ok' : q.status === 'declined' ? 'bad' : 'gray'}">${esc(q.status)}</span><span class="num">${fmt.money(q.total)}</span></div>`).join('') || '<p class="muted small">No quotes yet.</p>'}</div>` : ''}
        ${filesCard('deals', d.id, d.files, load)}</div>
      <div class="stack">${aiPanel('deals', d.id)}${composer({ deal_id: d.id, contact_id: d.contact_id, contact: d.contact }, load)}<div class="card"><h3>Timeline</h3>${timelineHtml(d.timeline)}</div></div></div>`;
    bindTimeline(main, d.timeline, load);
    $('#ed').onclick = () => Forms.deal(d, load);
    $$('[data-s]', main).forEach(b => b.onclick = async () => { if (Number(b.dataset.s) === d.stage_id) return; try { if (await moveDeal(d, b.dataset.s)) load(); } catch (x) { fail(x); } });
    $('#nq')?.addEventListener('click', async () => { const q = await api('POST', 'quotes', { deal_id: d.id }); go('#/quotes/' + q.id); });
  };
  await load();
});

// ---------------- pipeline board
route(/^\/pipeline$/, async (main, _, query) => {
  const pid = Number(query.get('p')) || ME.pipelines[0].id, p = ME.pipelines.find(x => x.id === pid) || ME.pipelines[0];
  const owner = query.get('owner') || '', qtext = query.get('q') || '';
  const { rows } = await api('GET', `deals?${qs({ pipeline_id: p.id, owner_id: owner, q: qtext, limit: 2000, sort: '-value' })}`);
  const today = fmt.today();
  main.innerHTML = `<div class="ph"><h2>Pipeline</h2>${ME.pipelines.length > 1 ? `<select id="pp" style="width:auto">${ME.pipelines.map(x => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
    <input type="search" id="pq" placeholder="Filter deals" value="${esc(qtext)}" style="width:180px"><select id="po" style="width:auto">${userOpts('All owners').map(([v, l]) => `<option value="${v}" ${String(v) === owner ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
    <a class="btn ghost" href="#/deals?pipeline_id=${p.id}">List view</a><button class="btn" id="nd">＋ Deal</button></div>
    <div class="board">${p.stages.map(s => {
      const ds = rows.filter(d => d.stage_id === s.id), tot = ds.reduce((a, d) => a + d.value, 0);
      return `<div class="col" data-s="${s.id}" data-kind="${s.kind}"><div class="ch"><b>${esc(s.name)}</b><span class="muted">${ds.length}</span></div><div class="ch muted"><span class="num">${fmt.money(tot)}</span>${s.kind === 'open' ? `<span data-tip="Weighted at ${s.probability}%">≈ ${fmt.compact(tot * s.probability / 100)}</span>` : ''}</div>
        ${ds.map(d => `<div class="dcard" draggable="true" data-id="${d.id}" tabindex="0"><div class="t">${esc(d.title)}</div><div class="m"><span>${esc(d.company_name || d.contact_name || '')}</span><b class="num" style="color:var(--tx)">${fmt.money(d.value)}</b></div>
          <div class="m"><span class="${s.kind === 'open' && d.close_date && d.close_date < today ? 'err' : ''}">${d.close_date ? icon('calendar', 13) + ' ' + fmt.date(d.close_date) : ''}</span>${avatar(d.owner_id)}</div></div>`).join('')}</div>`;
    }).join('')}</div><p class="small muted">Drag cards between stages. Moving to a Lost stage asks for a reason.</p>`;
  const nav = o => go(`#/pipeline?${qs({ p: p.id, owner, q: qtext, ...o })}`);
  $('#pp')?.addEventListener('change', e => nav({ p: e.target.value }));
  $('#po').onchange = e => nav({ owner: e.target.value });
  let t; $('#pq').oninput = e => { clearTimeout(t); t = setTimeout(() => nav({ q: e.target.value }), 400); };
  $('#nd').onclick = () => Forms.deal({ pipeline_id: p.id }, () => render());
  $$('.dcard', main).forEach(c => { c.ondragstart = e => { e.dataTransfer.setData('text/plain', c.dataset.id); e.dataTransfer.effectAllowed = 'move'; }; c.onclick = () => go('#/deals/' + c.dataset.id); c.onkeydown = e => { if (e.key === 'Enter') go('#/deals/' + c.dataset.id); }; });
  $$('.col', main).forEach(col => {
    col.ondragover = e => { e.preventDefault(); col.classList.add('over'); }; col.ondragleave = () => col.classList.remove('over');
    col.ondrop = async e => {
      e.preventDefault(); col.classList.remove('over'); const id = Number(e.dataTransfer.getData('text/plain')), d = rows.find(x => x.id === id);
      if (!d || d.stage_id === Number(col.dataset.s)) return;
      try { if (await moveDeal(d, col.dataset.s)) render(); } catch (x) { fail(x); }
    };
  });
});

// ---------------- tasks
route(/^\/tasks$/, async (main, _, query) => {
  const tab = query.get('tab') || 'open', mine = query.get('all') ? '' : '1';
  const params = { open: { done: 0, sort: 'due_date' }, overdue: { due: 'overdue' }, today: { due: 'today', done: 0 }, week: { due: 'week', done: 0 }, meetings: { type: 'meeting', due: 'upcoming', sort: 'start_at' }, done: { done: 1, sort: '-created_at' } }[tab];
  const { rows } = await api('GET', `activities?${qs({ ...params, mine, limit: 500 })}`);
  const today = fmt.today();
  main.innerHTML = `<div class="ph"><h2>Tasks & activities</h2><label class="row small" style="gap:5px"><input type="checkbox" id="all" ${mine ? '' : 'checked'}> Show team</label><button class="btn" id="nt">＋ New</button></div>
    ${tabsHtml([['open', 'Open'], ['overdue', 'Overdue'], ['today', 'Today'], ['week', 'Next 7 days'], ['meetings', 'Upcoming meetings'], ['done', 'Completed']].map(([k, l]) => [k, l, `#/tasks?${qs({ tab: k, all: mine ? '' : '1' })}`]), tab)}
    ${table({ rows, id: 'tt', empty: tab === 'overdue' ? 'Nothing overdue 🎉' : 'Nothing here.', onRow: a => Forms.task(a, () => render()),
      cols: [{ l: '', f: a => `<input type="checkbox" data-done="${a.id}" ${a.done ? 'checked' : ''} aria-label="Complete">` },
        { l: 'Activity', f: a => `<span style="${a.done ? 'text-decoration:line-through;opacity:.6' : ''}">${TL_ICON[a.type] || ''} <b>${esc(a.subject || a.note?.slice(0, 80) || a.type)}</b></span>${a.subject && a.note ? `<div class="small muted">${esc(a.note.slice(0, 100))}</div>` : ''}` },
        { l: 'When', f: a => a.start_at ? fmt.dt(a.start_at) : a.due_date ? `<span class="${!a.done && a.due_date < today ? 'err' : ''}">${fmt.date(a.due_date)}</span>` : '' },
        { l: 'Related', f: a => [a.deal_id && `<a href="#/deals/${a.deal_id}">${esc(a.deal_title)}</a>`, a.contact_id && `<a href="#/contacts/${a.contact_id}">${esc(a.contact_name)}</a>`].filter(Boolean).join(' · ') },
        { l: 'Owner', f: a => avatar(a.owner_id) }] })}`;
  $('#all').onchange = e => go(`#/tasks?${qs({ tab, all: e.target.checked ? '1' : '' })}`);
  $('#nt').onclick = () => Forms.task({}, () => render());
  $$('[data-done]', main).forEach(c => c.onchange = async () => { try { await api('PATCH', 'activities/' + c.dataset.done, { done: c.checked }); if (c.checked) toast('Completed'); render(); } catch (x) { fail(x); } });
});
