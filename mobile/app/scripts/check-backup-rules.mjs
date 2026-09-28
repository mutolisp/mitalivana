/**
 * Android backup rules (plugins/withBackupExclusions.js), security audit S5:
 *   - expo-secure-store's SharedPreferences are excluded (our rules replace
 *     the ones its plugin would add), in both files, both spellings;
 *   - the old plain-text GBIF credentials file is excluded;
 *   - no <include>: with one, Android backs up only what is included and
 *     user.db would silently leave the backup;
 *   - a prebuilt android/ carries exactly these files (run
 *     `node scripts/check-backup-rules.mjs --write` after changing the plugin,
 *     or prebuild).
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { DATA_EXTRACTION_RULES, FULL_BACKUP_CONTENT } = require('../plugins/withBackupExclusions.js');
const XML_DIR = 'android/app/src/main/res/xml';
const files = { 'data_extraction_rules.xml': DATA_EXTRACTION_RULES, 'backup_rules.xml': FULL_BACKUP_CONTENT };

const errors = [];
for (const [name, xml] of Object.entries(files)) {
  const sections = name === 'data_extraction_rules.xml' ? ['cloud-backup', 'device-transfer'] : ['full-backup-content'];
  for (const sec of sections) {
    const body = new RegExp(`<${sec}>([\\s\\S]*?)</${sec}>`).exec(xml)?.[1] ?? '';
    for (const p of ['SecureStore.xml', 'SecureStore']) if (!body.includes(`<exclude domain="sharedpref" path="${p}" />`)) errors.push(`${name} <${sec}>: SecureStore (${p}) not excluded`);
    if (!body.includes('<exclude domain="file" path="gbif_credentials.json" />')) errors.push(`${name} <${sec}>: gbif_credentials.json not excluded`);
  }
  if (/<include\b/.test(xml)) errors.push(`${name}: has an <include> — Android would back up only that, and user.db would drop out`);
  const out = `${XML_DIR}/${name}`;
  if (process.argv.includes('--write') && existsSync(XML_DIR)) writeFileSync(out, xml);
  else if (existsSync(out) && readFileSync(out, 'utf8') !== xml) errors.push(`${out} differs from the plugin (run: node scripts/check-backup-rules.mjs --write, or prebuild)`);
}
if (errors.length) {
  for (const e of errors) console.error(`✖ ${e}`);
  process.exit(1);
}
console.log('✓ backup rules: SecureStore and the old GBIF file excluded, no <include>, android/ up to date');
