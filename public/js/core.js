/* PipelineHQ SPA — core: API client, formatting, UI kit (modals, forms, tables, charts), router, shell, auth screens. */
'use strict';
const $ = (s, e = document) => e.querySelector(s), $$ = (s, e = document) => [...e.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const Pages = {}; let ME = null;

// ---------------- API
class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }
async function api(method, path, body, opts = {}) {
  const r = await fetch('/api/' + path.replace(/^\//, ''), { method, headers: opts.raw ? opts.headers : body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && !/^(login|signup|me|forgot|reset|invite)/.test(path)) { ME = null; location.hash = '#/login'; }
    throw new ApiError(j.error || `Request failed (${r.status})`, r.status, j);
  }
  return j;
}
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null && v !== false)).toString();

// ---------------- formatting
const fmt = {
  money: (v, cur) => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || ME?.org.currency || 'USD', maximumFractionDigits: 0 }).format(v || 0),
  money2: v => new Intl.NumberFormat(undefined, { style: 'currency', currency: ME?.org.currency || 'USD' }).format(v || 0),
  compact: v => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1, style: 'currency', currency: ME?.org.currency || 'USD' }).format(v || 0),
  utc: s => (s ? new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z') : null),
  date: s => { if (!s) return ''; const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00') : fmt.utc(s); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); },
  dt: s => { const d = fmt.utc(s); return d ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; },
  rel: s => { const d = fmt.utc(s); if (!d) return ''; const m = (Date.now() - d) / 60000; if (m < 1) return 'just now'; if (m < 60) return Math.round(m) + 'm ago'; if (m < 1440) return Math.round(m / 60) + 'h ago'; if (m < 10080) return Math.round(m / 1440) + 'd ago'; return fmt.date(s); },
  localInput: s => { const d = fmt.utc(s); if (!d) return ''; const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; },
  today: () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; },
  initials: n => String(n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase(),
  pct: v => (v == null ? '—' : v + '%'),
};
const user = id => ME?.users.find(u => u.id === id);
const userOpts = (none = '— Unassigned —', activeOnly = true) => [['', none], ...ME.users.filter(u => !activeOnly || u.active).map(u => [u.id, u.name])];
const can = { admin: () => ['owner', 'admin'].includes(ME.user.role), manage: () => ['owner', 'admin', 'manager'].includes(ME.user.role), pro: f => ME.plan.features.includes(f) };
const lifecycleTag = l => `<span class="tag ${l === 'customer' ? 'ok' : l === 'churned' ? 'bad' : l === 'lead' ? '' : 'gray'}">${esc(l)}</span>`;
const stageTag = (name, kind) => `<span class="tag ${kind === 'won' ? 'ok' : kind === 'lost' ? 'bad' : ''}">${kind === 'won' ? '✓ ' : kind === 'lost' ? '✕ ' : ''}${esc(name)}</span>`;
const avatar = id => { const u = user(id); return u ? `<span class="av" data-tip="${esc(u.name)}">${esc(fmt.initials(u.name))}</span>` : ''; };

// ---------------- toasts, tooltips
function toast(msg, kind = 'ok') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').append(t); setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3000); }
const fail = e => toast(e.message || String(e), 'bad');
document.addEventListener('mouseover', e => { const el = e.target.closest('[data-tip]'); const tip = $('#tip'); if (!tip) return; if (!el) { tip.hidden = true; return; } tip.textContent = el.dataset.tip; tip.hidden = false; });
document.addEventListener('mousemove', e => { const tip = $('#tip'); if (!tip || tip.hidden) return; const w = tip.offsetWidth; tip.style.left = Math.min(e.clientX + 14, innerWidth - w - 8) + 'px'; tip.style.top = (e.clientY + 16) + 'px'; });

// ---------------- modal + forms
function modal(title, html, { wide = false, onMount } = {}) {
  const d = document.createElement('div'); d.className = 'modal';
  d.innerHTML = `<div class="card ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><div class="mh"><h3>${esc(title)}</h3><button class="btn ghost sm" data-x aria-label="Close">✕</button></div><div class="mb-body">${html}</div></div>`;
  document.body.append(d);
  const close = () => { d.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  d.addEventListener('mousedown', e => { if (e.target === d) close(); });
  $('[data-x]', d).onclick = close;
  onMount?.(d, close);
  setTimeout(() => $('input:not([type=hidden]):not([type=checkbox]),select,textarea', d)?.focus(), 30);
  return { el: d, close };
}
function confirmBox(msg, { ok = 'Confirm', danger = true } = {}) {
  return new Promise(res => {
    const m = modal('Please confirm', `<p>${esc(msg)}</p><div class="mf"><span class="sp"></span><button class="btn ghost" data-n>Cancel</button><button class="btn ${danger ? 'danger' : ''}" data-y>${esc(ok)}</button></div>`);
    $('[data-y]', m.el).onclick = () => { m.close(); res(true); }; $('[data-n]', m.el).onclick = () => { m.close(); res(false); };
  });
}
function fieldHtml(f, v) {
  const id = 'f_' + f.k.replace(/\W/g, '_'), req = f.req ? 'required' : '', val = v ?? f.def ?? '';
  if (f.t === 'html') return f.html;
  let input;
  if (f.t === 'select') input = `<select id="${id}" name="${esc(f.k)}" ${req}>${f.opts.map(o => { const [ov, ol] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(ov)}" ${String(ov) === String(val) ? 'selected' : ''}>${esc(ol)}</option>`; }).join('')}</select>`;
  else if (f.t === 'textarea') input = `<textarea id="${id}" name="${esc(f.k)}" rows="${f.rows || 4}" ${req} placeholder="${esc(f.ph || '')}">${esc(val)}</textarea>`;
  else if (f.t === 'checkbox') return `<label class="row" style="margin-top:12px;gap:8px"><input type="checkbox" id="${id}" name="${esc(f.k)}" ${val === true || val === 1 || val === '1' ? 'checked' : ''}> ${esc(f.l)}</label>${f.help ? `<div class="help">${f.help}</div>` : ''}`;
  else if (f.t === 'multi') input = `<div class="row">${f.opts.map(o => { const [ov, ol] = Array.isArray(o) ? o : [o, o]; return `<label class="row" style="gap:5px"><input type="checkbox" data-multi="${esc(f.k)}" value="${esc(ov)}" ${(val || []).map(String).includes(String(ov)) ? 'checked' : ''}> ${esc(ol)}</label>`; }).join('')}</div>`;
  else input = `<input id="${id}" name="${esc(f.k)}" type="${f.t === 'datetime' ? 'datetime-local' : f.t || 'text'}" value="${esc(f.t === 'datetime' ? fmt.localInput(val) : val)}" ${req} ${f.t === 'number' ? 'step="any"' : ''} placeholder="${esc(f.ph || '')}" ${f.attrs || ''}>`;
  return `<label class="f" for="${id}">${esc(f.l)}${f.req ? ' *' : ''}</label>${input}${f.help ? `<div class="help">${f.help}</div>` : ''}`;
}
function readForm(form, fields) {
  const o = {};
  for (const f of fields) {
    if (f.t === 'html') continue;
    let v;
    if (f.t === 'checkbox') v = form.elements[f.k]?.checked || false;
    else if (f.t === 'multi') v = $$(`[data-multi="${CSS.escape(f.k)}"]:checked`, form).map(x => x.value);
    else { v = form.elements[f.k]?.value ?? ''; if (f.t === 'datetime' && v) v = new Date(v).toISOString(); }
    if (f.k.startsWith('custom.')) (o.custom ||= {})[f.k.slice(7)] = v; else o[f.k] = v;
  }
  return o;
}
// Generic create/edit form. submit(values) may throw; errors show inline.
function formModal({ title, fields, values = {}, submit, del, submitLabel = 'Save', wide, cols2, onMount, after }) {
  const val = f => (f.k.startsWith('custom.') ? values.custom?.[f.k.slice(7)] : values[f.k]);
  const m = modal(title, `<form novalidate><div class="${cols2 ? 'grid2' : ''}">${fields.map(f => `<div>${fieldHtml(f, val(f))}</div>`).join('')}</div><div class="err"></div>
    <div class="mf">${del ? '<button type="button" class="btn danger" data-del>Delete</button>' : ''}<span class="sp"></span><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn" data-save>${esc(submitLabel)}</button></div></form>`, { wide, onMount });
  const form = $('form', m.el);
  $('[data-cancel]', m.el).onclick = m.close;
  if (del) $('[data-del]', m.el).onclick = async () => { if (!(await confirmBox('Delete this permanently?', { ok: 'Delete' }))) return; try { await del(); m.close(); toast('Deleted'); after?.(); } catch (e) { $('.err', m.el).textContent = e.message; } };
  form.onsubmit = async e => {
    e.preventDefault(); if (!form.reportValidity()) return;
    const btn = $('[data-save]', m.el); btn.disabled = true;
    try { const r = await submit(readForm(form, fields), m); if (r !== false) { m.close(); after?.(r); } } catch (x) { $('.err', m.el).textContent = x.message; } finally { btn.disabled = false; }
  };
  return m;
}
const customFields = entity => (ME.fields[entity] || []).map(d => ({ k: 'custom.' + d.key, l: d.label, req: !!d.required, t: { number: 'number', date: 'date', select: 'select', checkbox: 'checkbox', email: 'email', url: 'url', textarea: 'textarea' }[d.type] || 'text', opts: d.type === 'select' ? [['', '—'], ...d.options] : undefined }));
const customValue = (d, v) => v == null || v === '' ? '' : d.type === 'checkbox' ? (v ? 'Yes' : 'No') : d.type === 'url' ? `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v.replace(/^https?:\/\//, ''))}</a>` : d.type === 'date' ? fmt.date(v) : esc(v);

// ---------------- tables
function table({ rows, cols, onRow, select = false, empty = 'Nothing here yet.', id = 't' + Math.random().toString(36).slice(2) }) {
  if (!rows.length) return `<div class="tw"><div class="empty">${empty}</div></div>`;
  setTimeout(() => {
    const t = document.getElementById(id); if (!t) return;
    if (onRow) $$('tr[data-i]', t).forEach(tr => tr.addEventListener('click', e => { if (e.target.closest('input,a,button,select')) return; onRow(rows[tr.dataset.i], e); }));
    if (select) { const all = $('[data-all]', t); all.onchange = () => { $$('[data-sel]', t).forEach(c => c.checked = all.checked); t.dispatchEvent(new Event('selchange')); }; $$('[data-sel]', t).forEach(c => c.onchange = () => t.dispatchEvent(new Event('selchange'))); }
  });
  return `<div class="tw"><table class="t" id="${id}"><thead><tr>${select ? '<th style="width:30px"><input type="checkbox" data-all aria-label="Select all"></th>' : ''}${cols.map(c => `<th class="${c.cls || ''}">${esc(c.l)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr data-i="${i}" class="${onRow ? 'click' : ''}">${select ? `<td><input type="checkbox" data-sel value="${r.id}" aria-label="Select"></td>` : ''}${cols.map(c => `<td class="${c.cls || ''}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const selected = tableEl => $$('[data-sel]:checked', tableEl).map(c => Number(c.value));
const tabsHtml = (items, active) => `<div class="tabs">${items.map(([k, l, href]) => `<a href="${href}" class="${k === active ? 'on' : ''}">${esc(l)}</a>`).join('')}</div>`;

// ---------------- charts (validated palette; hover tooltips on every mark; text in ink tokens)
const Chart = {
  hbars(items, { fmt: f = fmt.money, ordinal = false } = {}) {
    const max = Math.max(1, ...items.map(i => i.value));
    return `<div class="hbar viz">${items.map(i => `<div class="lab" title="${esc(i.label)}">${esc(i.label)}</div>
      <div class="trk" data-tip="${esc(i.label)}\n${esc(i.tip || f(i.value))}"><div class="fill ${ordinal ? 'ord' : ''}" style="width:${(i.value / max) * 100}%"></div></div>
      <div class="val">${esc(i.text ?? f(i.value))}</div>`).join('')}</div>`;
  },
  // series: [{key,label,cls}], rows: [{label, values:{key:n}, quota?}]
  columns(rows, series, { fmt: f = fmt.compact, quota = false } = {}) {
    const max = Math.max(1, ...rows.flatMap(r => [...series.map(s => r.values[s.key] || 0), quota ? r.quota || 0 : 0]));
    const nice = (() => { const p = 10 ** Math.floor(Math.log10(max)); return Math.ceil(max / p / 2) * p * 2; })();
    const legend = series.length > 1 || quota ? `<div class="legend">${series.map(s => `<span><i class="${s.cls || ''}"></i>${esc(s.label)}</span>`).join('')}${quota ? '<span><i class="q"></i>Quota</span>' : ''}</div>` : '';
    return `${legend}<div class="viz" style="padding:8px 4px 4px"><div class="colchart">
      ${[0.5, 1].map(p => `<div class="gl" style="bottom:${p * 100}%"></div><div class="yl" style="bottom:${p * 100}%;transform:translateY(50%)">${esc(f(nice * p))}</div>`).join('')}
      ${rows.map(r => `<div class="grp" data-tip="${esc(r.label)}\n${series.map(s => `${s.label}: ${fmt.money(r.values[s.key] || 0)}`).join('\n')}${quota && r.quota ? `\nQuota: ${fmt.money(r.quota)}` : ''}">
        ${series.map(s => `<div class="bar ${s.cls || ''}" style="height:${((r.values[s.key] || 0) / nice) * 100}%"></div>`).join('')}
        ${quota && r.quota ? `<div class="q" style="bottom:${(r.quota / nice) * 100}%"></div>` : ''}</div>`).join('')}
    </div><div class="xlabs">${rows.map(r => `<span>${esc(r.short || r.label)}</span>`).join('')}</div></div>`;
  },
  meter: (v, max) => `<div class="meter" data-tip="${esc(fmt.money(v))} of ${esc(fmt.money(max))} (${max ? Math.round(100 * v / max) : 0}%)"><span style="width:${max ? Math.min(100, 100 * v / max) : 0}%"></span></div>`,
};
const monthLabel = m => new Date(m + '-01T00:00').toLocaleDateString(undefined, { month: 'short', year: '2-digit' });

// ---------------- router
const ROUTES = [];
const route = (re, fn, opts = {}) => ROUTES.push({ re, fn, ...opts });
function parseHash() { const h = location.hash.slice(1) || '/'; const [p, q] = h.split('?'); return { path: p || '/', query: new URLSearchParams(q || '') }; }
const go = h => { if (location.hash === h) render(); else location.hash = h; };
window.addEventListener('hashchange', () => render());

async function render() {
  const { path, query } = parseHash();
  const r = ROUTES.find(x => x.re.test(path));
  if (r?.public) { ME = null; return r.fn(null, path.match(r.re), query); }
  if (!ME) { try { ME = await api('GET', 'me'); } catch { return go('#/login'); } }
  if (!$('#app')) shell();
  $$('nav.side a').forEach(a => a.classList.toggle('on', path === a.getAttribute('href').slice(1) || (a.getAttribute('href') !== '#/' && path.startsWith(a.getAttribute('href').slice(1)))));
  $('nav.side').classList.remove('open');
  const gs = $('#gs'); if (gs && document.activeElement !== gs) { gs.value = ''; $('#gsr')?.classList.add('hide'); }
  const main = $('#m'); main.innerHTML = '<p class="muted">Loading…</p>';
  if (!r) { main.innerHTML = '<div class="empty">Page not found.</div>'; return; }
  try { await r.fn(main, path.match(r.re), query); } catch (e) { if (e.status === 402) main.innerHTML = upgradeCard(e.message); else main.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
  main.focus?.();
}
const upgradeCard = msg => `<div class="card" style="max-width:520px"><h3>Upgrade to Pro</h3><p class="muted">${esc(msg)}</p><a class="btn" href="#/settings/billing">See plans</a></div>`;
async function refreshMe() { ME = await api('GET', 'me'); shell(); }

// ---------------- shell
const NAV = [
  ['', [['#/', '📊', 'Dashboard'], ['#/pipeline', '🧲', 'Pipeline'], ['#/deals', '💼', 'Deals'], ['#/contacts', '👤', 'Contacts'], ['#/companies', '🏢', 'Companies'], ['#/tasks', '✅', 'Tasks']]],
  ['Engage', [['#/email', '✉️', 'Email'], ['#/leads', '🎯', 'Lead capture'], ['#/meetings', '📅', 'Meetings'], ['#/quotes', '🧾', 'Quotes']]],
  ['Insights', [['#/forecast', '📈', 'Forecast'], ['#/reports', '📋', 'Reports']]],
  ['Workspace', [['#/automations', '⚡', 'Automations'], ['#/settings', '⚙️', 'Settings']]],
];
function shell() {
  const trial = ME.plan.trial_days_left, free = ME.plan.plan === 'free';
  $('#root').innerHTML = `<div id="app"><nav class="side" aria-label="Main"><div class="brand"><img src="icon.svg" width="24" height="24" alt="">PipelineHQ</div>
    ${NAV.map(([sec, items]) => `${sec ? `<div class="sec">${sec}</div>` : ''}${items.map(([h, i, l]) => `<a href="${h}"><span class="ico">${i}</span>${l}</a>`).join('')}`).join('')}
    ${ME.superadmin || ME.impersonating ? '<div class="sec">Platform</div><a href="#/admin"><span class="ico">🛡️</span>Admin</a>' : ''}
    <div style="margin-top:auto;padding:12px 10px 0;font-size:12px" class="muted">${esc(ME.org.name)} · <span class="tag">${esc(ME.plan.label)}</span></div></nav>
  <div class="main">
    ${ME.impersonating ? `<div class="banner warn">🛡️ Viewing as ${esc(ME.user.name)} (${esc(ME.user.email)}) <button class="btn sm" id="stopImp">Stop impersonating</button></div>` : ''}
    ${trial ? `<div class="banner info">Pro trial — ${trial} day${trial === 1 ? '' : 's'} left. ${ME.user.role === 'owner' ? '<a href="#/settings/billing">Choose a plan</a>' : ''}</div>` : free ? `<div class="banner info">You're on the Free plan. ${ME.user.role === 'owner' ? '<a href="#/settings/billing">Upgrade to Pro</a> for automation, sequences, AI, forecasting and more.' : ''}</div>` : ''}
    <header class="top"><button class="iconbtn" id="burger" aria-label="Menu">☰</button>
      <div class="search"><input type="search" id="gs" placeholder="Search contacts, companies, deals…  ( / )" autocomplete="off" aria-label="Search"><div class="res hide" id="gsr"></div></div>
      <span class="grow"></span>
      <div style="position:relative"><button class="btn" id="quick" aria-label="Create new">＋<span class="lbl"> New</span></button></div>
      <div style="position:relative"><button class="iconbtn" id="bell" aria-label="Notifications">🔔${ME.unread ? `<span class="badge">${ME.unread > 99 ? '99+' : ME.unread}</span>` : ''}</button></div>
      <div style="position:relative"><button class="iconbtn" id="um" aria-label="Account"><span class="av">${esc(fmt.initials(ME.user.name))}</span></button></div>
    </header><main id="m" tabindex="-1"></main></div></div>`;
  $('#burger').onclick = () => $('nav.side').classList.toggle('open');
  $('#stopImp')?.addEventListener('click', async () => { await api('POST', 'sa/stop'); ME = null; $('#root').innerHTML = ''; go('#/admin'); });
  setupSearch();
  $('#bell').onclick = e => dropdown(e.currentTarget, async d => {
    const list = await api('GET', 'notifications');
    d.innerHTML = `<div class="row" style="padding:10px 12px;border-bottom:1px solid var(--bd)"><b class="grow">Notifications</b><button class="btn link small" data-all>Mark all read</button></div>
      ${list.map(n => `<a class="it ${n.read ? '' : 'unread'}" href="${esc(n.link || '#/')}" data-id="${n.id}">${esc(n.text)}<div class="small muted">${fmt.rel(n.created_at)}</div></a>`).join('') || '<div class="empty">You are all caught up.</div>'}`;
    $('[data-all]', d).onclick = async () => { await api('POST', 'notifications/read', {}); ME.unread = 0; $('#bell .badge')?.remove(); d.remove(); };
    $$('.it', d).forEach(a => a.onclick = () => { api('POST', 'notifications/read', { ids: [a.dataset.id] }); });
  });
  $('#um').onclick = e => dropdown(e.currentTarget, d => {
    d.style.width = '240px';
    d.innerHTML = `<div class="it"><b>${esc(ME.user.name)}</b><div class="small muted">${esc(ME.user.email)} · ${esc(ME.user.role)}</div></div>
      <a class="it" href="#/settings/profile">Profile & email</a><a class="it" href="#/settings/security">Security</a>
      <a class="it" href="#" data-theme>Theme: ${{ light: 'Light', dark: 'Dark' }[document.documentElement.dataset.theme] || 'System'}</a><a class="it" href="#" data-out>Sign out</a>`;
    $('[data-out]', d).onclick = async ev => { ev.preventDefault(); await api('POST', 'logout'); ME = null; $('#root').innerHTML = ''; go('#/login'); };
    $('[data-theme]', d).onclick = ev => { ev.preventDefault(); const cur = document.documentElement.dataset.theme; const next = !cur ? 'dark' : cur === 'dark' ? 'light' : ''; setTheme(next); d.remove(); };
  });
  $('#quick').onclick = e => dropdown(e.currentTarget, d => {
    d.style.width = '200px';
    d.innerHTML = [['deal', '💼 Deal'], ['contact', '👤 Contact'], ['company', '🏢 Company'], ['task', '✅ Task']].map(([k, l]) => `<a class="it" href="#" data-k="${k}">${l}</a>`).join('');
    $$('[data-k]', d).forEach(a => a.onclick = ev => { ev.preventDefault(); d.remove(); Forms[a.dataset.k]({}, r => go(`#/${{ deal: 'deals', contact: 'contacts', company: 'companies', task: 'tasks' }[a.dataset.k]}${a.dataset.k === 'task' ? '' : '/' + r.id}`)); });
  });
}
function setTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; try { t ? localStorage.setItem('theme', t) : localStorage.removeItem('theme'); } catch { } }
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch { }

function dropdown(anchor, fill) {
  const open = $('.drop'); open?.remove(); if (open?.dataset.for === anchor.id) return;
  const d = document.createElement('div'); d.className = 'drop'; d.dataset.for = anchor.id; d.innerHTML = '<div class="empty">Loading…</div>';
  anchor.parentElement.append(d);
  Promise.resolve(fill(d)).catch(fail);
  setTimeout(() => document.addEventListener('click', function h(e) { if (!d.contains(e.target) || e.target.closest('a.it')) { d.remove(); document.removeEventListener('click', h); } }));
}
function setupSearch() {
  const inp = $('#gs'), res = $('#gsr'); let timer, idx = -1;
  document.addEventListener('keydown', e => { if (e.key === '/' && !e.target.closest('input,textarea,select')) { e.preventDefault(); inp.focus(); } });
  inp.oninput = () => {
    clearTimeout(timer); const v = inp.value.trim(); if (v.length < 2) { res.classList.add('hide'); return; }
    timer = setTimeout(async () => {
      const r = await api('GET', 'search?' + qs({ q: v })); idx = -1;
      const sec = (t, items, base) => items.length ? `<h4>${t}</h4>${items.map(i => `<a href="#/${base}/${i.id}">${esc(i.name)} <span class="small muted">${esc(i.sub || '')}</span></a>`).join('')}` : '';
      res.innerHTML = sec('Contacts', r.contacts, 'contacts') + sec('Companies', r.companies, 'companies') + sec('Deals', r.deals, 'deals') || '<div class="empty">No matches</div>';
      res.classList.remove('hide');
    }, 180);
  };
  inp.onkeydown = e => {
    const links = $$('a', res);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, Math.min(links.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1))); links.forEach((a, i) => a.classList.toggle('sel', i === idx)); }
    if (e.key === 'Enter' && links[Math.max(idx, 0)]) { location.hash = links[Math.max(idx, 0)].getAttribute('href'); res.classList.add('hide'); inp.value = ''; inp.blur(); }
    if (e.key === 'Escape') { res.classList.add('hide'); inp.blur(); }
  };
  res.onclick = () => { res.classList.add('hide'); inp.value = ''; };
  inp.onblur = () => setTimeout(() => res.classList.add('hide'), 200);
}

// ---------------- auth screens
function authPage(inner) { $('#root').innerHTML = `<div class="auth"><div class="brand">PipelineHQ</div><div class="card">${inner}</div></div>`; }
function authForm(fields, submitLabel, onSubmit) {
  return { html: `<form id="af">${fields.map(f => fieldHtml(f)).join('')}<div class="err" id="ae"></div><button class="btn" style="width:100%;justify-content:center;margin-top:8px">${submitLabel}</button></form>`,
    bind: () => { const f = $('#af'); f.onsubmit = async e => { e.preventDefault(); const b = $('button', f); b.disabled = true; try { await onSubmit(readForm(f, fields)); } catch (x) { $('#ae').textContent = x.message; } finally { b.disabled = false; } }; } };
}
const enterApp = async () => { ME = await api('GET', 'me'); $('#root').innerHTML = ''; go('#/'); };
route(/^\/login$/, async (m, _, q) => {
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  const f = authForm([{ k: 'email', l: 'Email', t: 'email', req: 1, attrs: 'autocomplete="email"' }, { k: 'password', l: 'Password', t: 'password', req: 1, attrs: 'autocomplete="current-password"' }], 'Sign in', async v => {
    const r = await api('POST', 'login', v);
    if (r.need_2fa) {
      const g = authForm([{ k: 'code', l: 'Authenticator code', req: 1, attrs: 'inputmode="numeric" autocomplete="one-time-code" maxlength="8"' }], 'Verify', async c => { await api('POST', 'login/2fa', { ticket: r.ticket, code: c.code }); await enterApp(); });
      authPage(`<h2>Two-factor authentication</h2><p class="muted">Enter the 6-digit code from your authenticator app.</p>${g.html}`); g.bind(); return;
    }
    await enterApp();
  });
  authPage(`<h2>Sign in</h2>${q.get('error') ? `<p class="err">Sign-in failed: ${esc(q.get('error'))}</p>` : ''}${cfg.google ? '<a class="btn ghost" style="width:100%;justify-content:center;margin-top:12px" href="/auth/google/start">Continue with Google</a><div class="or">or</div>' : ''}${f.html}
    <p class="small"><a href="#/forgot">Forgot password?</a> · <a href="#/signup">Create a workspace</a></p>`); f.bind();
}, { public: true });
route(/^\/signup$/, async () => {
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  const f = authForm([{ k: 'org', l: 'Company name', req: 1 }, { k: 'name', l: 'Your name', req: 1, attrs: 'autocomplete="name"' }, { k: 'email', l: 'Work email', t: 'email', req: 1, attrs: 'autocomplete="email"' },
    { k: 'password', l: 'Password', t: 'password', req: 1, help: 'At least 8 characters', attrs: 'minlength="8" autocomplete="new-password"' }], 'Start free trial', async v => { await api('POST', 'signup', v); await enterApp(); });
  authPage(`<h2>Create your workspace</h2><p class="muted small">14-day Pro trial. No credit card required.</p>${cfg.google ? '<a class="btn ghost" style="width:100%;justify-content:center;margin-top:12px" href="/auth/google/start">Sign up with Google</a><div class="or">or</div>' : ''}${f.html}<p class="small">Already have an account? <a href="#/login">Sign in</a></p>`); f.bind();
}, { public: true });
route(/^\/forgot$/, () => {
  const f = authForm([{ k: 'email', l: 'Email', t: 'email', req: 1 }], 'Send reset link', async v => {
    const r = await api('POST', 'forgot', v);
    authPage(`<h2>Check your email</h2><p class="muted">If an account exists for ${esc(v.email)}, we sent a reset link.</p>${r.dev_link ? `<p class="small">Dev mode (no mail provider): <a href="${esc(r.dev_link)}">open reset link</a></p>` : ''}<p><a href="#/login">Back to sign in</a></p>`);
  });
  authPage(`<h2>Reset password</h2>${f.html}<p class="small"><a href="#/login">Back to sign in</a></p>`); f.bind();
}, { public: true });
route(/^\/reset$/, (m, _, q) => {
  const f = authForm([{ k: 'password', l: 'New password', t: 'password', req: 1, attrs: 'minlength="8" autocomplete="new-password"' }], 'Set password', async v => { await api('POST', 'reset', { token: q.get('token'), password: v.password }); await enterApp(); });
  authPage(`<h2>Choose a new password</h2>${f.html}`); f.bind();
}, { public: true });
route(/^\/accept$/, async (m, _, q) => {
  let inv; try { inv = await api('GET', 'invite/' + encodeURIComponent(q.get('token') || '')); } catch (e) { return authPage(`<h2>Invite</h2><p class="err">${esc(e.message)}</p><a href="#/login">Sign in</a>`); }
  const f = authForm([{ k: 'name', l: 'Your name', req: 1 }, { k: 'password', l: 'Password', t: 'password', req: 1, attrs: 'minlength="8" autocomplete="new-password"' }], 'Join workspace', async v => { await api('POST', 'invite/accept', { ...v, token: q.get('token') }); await enterApp(); });
  authPage(`<h2>Join ${esc(inv.org)}</h2><p class="muted">Signing up as ${esc(inv.email)}</p>${f.html}`); f.bind();
}, { public: true });

document.addEventListener('DOMContentLoaded', () => render());
