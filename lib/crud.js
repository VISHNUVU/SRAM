// Generic org-scoped CRUD for configuration tables with column whitelists.
const { q, one, run, insert } = require('./db');
const { bad, clean } = require('./util');
const { audit } = require('./core');

function pick(def, body, partial) {
  const out = {};
  for (const c of def.cols) {
    if (!(c in body)) continue;
    let v = body[c];
    if (def.json?.includes(c)) v = JSON.stringify(v ?? (c === 'events' ? ['*'] : []));
    else if (def.bool?.includes(c)) v = v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0;
    else if (def.num?.includes(c)) { if (v === '' || v == null) v = null; else { v = Number(v); if (!Number.isFinite(v)) bad(`${c} must be a number`); } }
    else v = v === '' ? null : clean(v);
    out[c] = v;
  }
  if (!partial) for (const r of def.req || []) if (out[r] == null || out[r] === '') bad(`${r} is required`);
  return out;
}

function crud(router, base, table, def) {
  const opts = { roles: def.roles, feature: def.feature };
  const readOpts = { feature: def.feature };
  const decode = row => { if (row) for (const c of def.json || []) row[c] = JSON.parse(row[c] || 'null'); return row; };
  const getOwn = (ctx, id) => { const r = one(`SELECT * FROM ${table} WHERE id=? AND org_id=?`, Number(id), ctx.user.org_id); if (!r) bad('not found', 404); return r; };
  router.get(base, readOpts, ctx => q(def.list || `SELECT * FROM ${table} WHERE org_id=? ORDER BY id DESC`, ctx.user.org_id).map(decode));
  router.get(base + '/:id', readOpts, ctx => decode(getOwn(ctx, ctx.params.id)));
  router.post(base, opts, ctx => {
    const o = pick(def, ctx.body, false);
    if (def.validate) def.validate(o, ctx, null);
    const id = insert(table, { org_id: ctx.user.org_id, ...(def.defaults ? def.defaults(ctx) : {}), ...o });
    audit(ctx, 'create', table, id, { name: o.name || o.title || undefined });
    return decode(one(`SELECT * FROM ${table} WHERE id=?`, id));
  });
  router.patch(base + '/:id', opts, ctx => {
    const ex = getOwn(ctx, ctx.params.id), o = pick(def, ctx.body, true);
    if (def.validate) def.validate(o, ctx, ex);
    const cols = Object.keys(o);
    if (cols.length) run(`UPDATE ${table} SET ${cols.map(c => c + '=?').join(',')} WHERE id=? AND org_id=?`, ...cols.map(c => o[c]), ex.id, ctx.user.org_id);
    audit(ctx, 'update', table, ex.id, cols);
    return decode(one(`SELECT * FROM ${table} WHERE id=?`, ex.id));
  });
  router.del(base + '/:id', opts, ctx => {
    const ex = getOwn(ctx, ctx.params.id);
    if (def.beforeDelete) def.beforeDelete(ex, ctx);
    run(`DELETE FROM ${table} WHERE id=? AND org_id=?`, ex.id, ctx.user.org_id);
    audit(ctx, 'delete', table, ex.id, { name: ex.name || ex.title || undefined });
  });
}
module.exports = { crud, pick };
