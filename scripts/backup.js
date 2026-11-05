// Online, consistent SQLite backup (VACUUM INTO), optionally encrypted with AES-256-GCM.
// Usage: node scripts/backup.js [outDir]     env: DATA_DIR, DB_FILE, BACKUP_KEY (any passphrase → encrypts the file), BACKUP_KEEP (default 14)
// Restore: stop the app, decrypt if needed (node scripts/backup.js --decrypt file.enc out.db), replace data/crm.db.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const key = pass => crypto.createHash('sha256').update(pass).digest();
if (process.argv[2] === '--decrypt') {
  const [, , , input, output] = process.argv; const buf = fs.readFileSync(input);
  const d = crypto.createDecipheriv('aes-256-gcm', key(process.env.BACKUP_KEY || ''), buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28));
  fs.writeFileSync(output, Buffer.concat([d.update(buf.subarray(28)), d.final()])); console.log('decrypted →', output); process.exit(0);
}
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbFile = process.env.DB_FILE || path.join(dataDir, 'crm.db');
const outDir = process.argv[2] || path.join(dataDir, 'backups'); fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-'), out = path.join(outDir, `crm-${stamp}.db`);
new DatabaseSync(dbFile).exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
let final = out;
if (process.env.BACKUP_KEY) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(process.env.BACKUP_KEY), iv);
  const enc = Buffer.concat([c.update(fs.readFileSync(out)), c.final()]);
  final = out + '.enc'; fs.writeFileSync(final, Buffer.concat([iv, c.getAuthTag(), enc])); fs.unlinkSync(out);
}
const keep = Number(process.env.BACKUP_KEEP || 14);
const all = fs.readdirSync(outDir).filter(f => /^crm-.*\.db(\.enc)?$/.test(f)).sort();
for (const f of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(outDir, f));
console.log('backup written →', final, `(${(fs.statSync(final).size / 1024).toFixed(0)} KB)`);
console.log('note: uploaded files live in', path.join(dataDir, 'files'), '— back that directory up too.');
