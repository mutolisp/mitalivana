/**
 * Every place that starts a checklist or plot as a side effect ends whatever
 * record is active (closeActiveRecords). A MIREN survey was ended that way by
 * the "add species" paths (data-model audit A11), so each implicit start must
 * sit right behind a guard:
 *   - add-species paths: blockIfMirenActive() (src/lib/mirenGuard.ts) AND
 *     takenByActiveSurvey() (src/survey/form/quickAdd.ts), which hands the
 *     species to an open checklist / plot-style survey or refuses it;
 *   - "new record" paths: ensureNoConflictingActive() (src/lib/recordCreate.ts).
 * Text check: each start call needs them within the 15 lines above it (the
 * same function, in practice), or a `// add-guard: <reason>` comment when its
 * only caller is guarded. The DB helpers and the store that define the calls
 * are not callers.
 */
import { readdirSync, readFileSync } from 'node:fs';

const START = /\b(startSession|startActive|startActiveSession)\(\)|\.getState\(\)\.start\(\)|\bstore\.start\(\)|\bcreateSession\(|\bcreatePlotSurvey\(|\bcreateSurvey\(/;
// Or, for a call its only caller already guards, a comment naming why: `// add-guard: <reason>`.
const CONFLICT = /\bensureNoConflictingActive\(|\/\/ add-guard: \S.{10,}/;
const MIREN = /\bblockIfMirenActive\(/;
const SURVEY = /\btakenByActiveSurvey\(/;
const WINDOW = 15;
const NOT_CALLERS = new Set([
  'src/db/sessions.ts',
  'src/db/plots.ts',
  'src/db/index.ts',
  'src/stores/activeSession.ts',
  'src/lib/mirenGuard.ts',
  'src/survey/db/surveyCore.ts',
  'src/survey/db/surveys.ts',
]);

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
};
walk('src');
walk('app');

const errors = [];
let calls = 0;
for (const f of files) {
  if (NOT_CALLERS.has(f)) continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line) || /^\s*import\b/.test(line) || /function (createSession|createPlotSurvey|createSurvey)\b/.test(line)) return;
    if (!START.test(line)) return;
    calls++;
    const before = lines.slice(Math.max(0, i - WINDOW), i + 1).join('\n');
    if (CONFLICT.test(before)) return;
    if (!MIREN.test(before) || !SURVEY.test(before)) {
      errors.push(`${f}:${i + 1}: starts a record without ensureNoConflictingActive(), or blockIfMirenActive() and takenByActiveSurvey(), just before it\n    ${line.trim()}`);
    }
  });
}
if (errors.length) {
  for (const e of errors) console.error(`✖ ${e}`);
  process.exit(1);
}
console.log(`✓ add guard: ${calls} implicit record starts, each behind the conflict guard or the MIREN and survey guards`);
