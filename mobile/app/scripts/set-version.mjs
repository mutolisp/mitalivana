#!/usr/bin/env node
/**
 * Set — or check — the app version in every place that carries it.
 *
 * There are twelve, across six files in four formats, and they disagree
 * silently: the marketing version lives in `app.config.ts`, but `ios/` and
 * `android/` are prebuild artefacts with their own copies, `package.json` has
 * a third, and `about.tsx` carries fallbacks for when `expoConfig` is absent.
 * A mismatch is invisible until App Store Connect rejects the upload or Play
 * calls it a downgrade — 0.5.1 shipped with `CFBundleVersion` 20 while the
 * Xcode project said 19, and nothing noticed.
 *
 *   make build_verb_num=0.5.2_22             # from the repo root — set all twelve
 *   make check-version                       # verify they agree (exit 1 if not)
 *
 * Or directly:
 *   node scripts/set-version.mjs 0.5.2_22
 *   node scripts/set-version.mjs --check
 *
 * `ios.buildNumber` / `android.versionCode` are written into `app.config.ts`
 * as well as the native files on purpose: without them a future
 * `expo prebuild` regenerates the native side from the config and resets the
 * build number to 1.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const at = (p) => ROOT + p;

/** One place a version lives: how to read it, and how to rewrite it. */
const SITES = [
  {
    label: 'app.config.ts · version',
    file: 'app.config.ts',
    read: (s) => s.match(/^\s*version: '([^']+)',$/m)?.[1],
    write: (s, { version }) => s.replace(/^(\s*version: ')[^']+(',)$/m, `$1${version}$2`),
    kind: 'version',
  },
  {
    label: 'app.config.ts · ios.buildNumber',
    file: 'app.config.ts',
    read: (s) => s.match(/buildNumber: '(\d+)'/)?.[1],
    write: (s, { build }) => s.replace(/(buildNumber: ')\d+(')/, `$1${build}$2`),
    kind: 'build',
  },
  {
    label: 'app.config.ts · android.versionCode',
    file: 'app.config.ts',
    read: (s) => s.match(/versionCode: (\d+)/)?.[1],
    write: (s, { build }) => s.replace(/(versionCode: )\d+/, `$1${build}`),
    kind: 'build',
  },
  {
    // Line-anchored: `"version"` also appears on every dependency.
    label: 'package.json · version',
    file: 'package.json',
    read: (s) => s.match(/^  "version": "([^"]+)",$/m)?.[1],
    write: (s, { version }) => s.replace(/^(  "version": ")[^"]+(",)$/m, `$1${version}$2`),
    kind: 'version',
  },
  {
    label: 'app/about.tsx · fallback',
    file: 'app/about.tsx',
    read: (s) => s.match(/expoConfig\?\.version \?\? '([^']+)'/)?.[1],
    write: (s, { version }) =>
      s.replace(/(expoConfig\?\.version \?\? ')[^']+(')/, `$1${version}$2`),
    kind: 'version',
  },
  {
    // The fallbacks only show when `expoConfig` is unavailable, but a stale one
    // then reports a version the binary is not — worse than showing nothing.
    label: 'app/about.tsx · build fallback',
    file: 'app/about.tsx',
    read: (s) => s.match(/\}\) \?\? '(\d+)';/)?.[1],
    write: (s, { build }) => s.replace(/(\}\) \?\? ')\d+(';)/, `$1${build}$2`),
    kind: 'build',
  },
  {
    label: 'Info.plist · CFBundleShortVersionString',
    file: 'ios/Checklister/Info.plist',
    read: (s) => s.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1],
    write: (s, { version }) =>
      s.replace(
        /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/,
        `$1${version}$2`,
      ),
    kind: 'version',
  },
  {
    label: 'Info.plist · CFBundleVersion',
    file: 'ios/Checklister/Info.plist',
    read: (s) => s.match(/<key>CFBundleVersion<\/key>\s*<string>(\d+)<\/string>/)?.[1],
    write: (s, { build }) =>
      s.replace(/(<key>CFBundleVersion<\/key>\s*<string>)\d+(<\/string>)/, `$1${build}$2`),
    kind: 'build',
  },
  {
    // Two build configurations (Debug + Release), so replace globally.
    label: 'project.pbxproj · MARKETING_VERSION',
    file: 'ios/Checklister.xcodeproj/project.pbxproj',
    read: (s) => s.match(/MARKETING_VERSION = ([^;]+);/)?.[1],
    write: (s, { version }) =>
      s.replace(/(MARKETING_VERSION = )[^;]+;/g, `$1${version};`),
    kind: 'version',
  },
  {
    label: 'project.pbxproj · CURRENT_PROJECT_VERSION',
    file: 'ios/Checklister.xcodeproj/project.pbxproj',
    read: (s) => s.match(/CURRENT_PROJECT_VERSION = (\d+);/)?.[1],
    write: (s, { build }) => s.replace(/(CURRENT_PROJECT_VERSION = )\d+;/g, `$1${build};`),
    kind: 'build',
  },
  {
    label: 'build.gradle · versionName',
    file: 'android/app/build.gradle',
    read: (s) => s.match(/versionName "([^"]+)"/)?.[1],
    write: (s, { version }) => s.replace(/(versionName ")[^"]+(")/, `$1${version}$2`),
    kind: 'version',
  },
  {
    label: 'build.gradle · versionCode',
    file: 'android/app/build.gradle',
    read: (s) => s.match(/versionCode (\d+)/)?.[1],
    write: (s, { build }) => s.replace(/(versionCode )\d+/, `$1${build}`),
    kind: 'build',
  },
];

function readAll() {
  const cache = new Map();
  return SITES.map((site) => {
    if (!cache.has(site.file)) cache.set(site.file, readFileSync(at(site.file), 'utf8'));
    return { site, value: site.read(cache.get(site.file)) };
  });
}

const arg = process.argv[2];

// ── check ────────────────────────────────────────────────────────────────
if (arg === '--check' || !arg) {
  const found = readAll();
  const missing = found.filter((f) => f.value === undefined);
  const versions = new Set(found.filter((f) => f.site.kind === 'version').map((f) => f.value));
  const builds = new Set(found.filter((f) => f.site.kind === 'build').map((f) => f.value));

  for (const { site, value } of found) {
    console.log(`  ${value === undefined ? '✗' : ' '} ${site.label.padEnd(42)} ${value ?? '— not found —'}`);
  }
  let bad = 0;
  if (missing.length) {
    console.error(`\n✗ ${missing.length} place(s) could not be read — the file format changed.`);
    bad = 1;
  }
  if (versions.size > 1) {
    console.error(`\n✗ versions disagree: ${[...versions].join(' / ')}`);
    bad = 1;
  }
  if (builds.size > 1) {
    console.error(`✗ build numbers disagree: ${[...builds].join(' / ')}`);
    bad = 1;
  }
  if (bad) {
    console.error('\nFix with:  make build_verb_num=<version>_<build>');
    process.exit(1);
  }
  console.log(`\n✓ version: ${[...versions][0]} build ${[...builds][0]} — all ${SITES.length} places agree`);
  process.exit(0);
}

// ── set ──────────────────────────────────────────────────────────────────
const m = /^(\d+\.\d+\.\d+)_(\d+)$/.exec(arg);
if (!m) {
  console.error(`Expected <major.minor.patch>_<build>, e.g. 0.5.2_22 — got "${arg}"`);
  process.exit(1);
}
const [, version, build] = m;

// Build numbers only ever go up: App Store Connect rejects a repeat and Play
// treats a lower versionCode as a downgrade. Catch the typo here rather than
// at upload time.
const currentBuilds = readAll()
  .filter((f) => f.site.kind === 'build')
  .map((f) => Number(f.value))
  .filter((n) => Number.isFinite(n));
const highest = Math.max(0, ...currentBuilds);
if (Number(build) <= highest && process.env.ALLOW_BUILD_DOWNGRADE !== '1') {
  console.error(
    `✗ build ${build} is not above the current ${highest}.\n` +
      `  A repeated build number is rejected by App Store Connect and read as a\n` +
      `  downgrade by Play. Use ${highest + 1} or higher, or set ALLOW_BUILD_DOWNGRADE=1\n` +
      `  if you really mean it.`,
  );
  process.exit(1);
}

const byFile = new Map();
for (const site of SITES) {
  if (!byFile.has(site.file)) byFile.set(site.file, readFileSync(at(site.file), 'utf8'));
  const before = byFile.get(site.file);
  const after = site.write(before, { version, build });
  if (after === before && site.read(before) !== (site.kind === 'version' ? version : build)) {
    console.error(`✗ ${site.label}: pattern did not match — the file format changed.`);
    process.exit(1);
  }
  byFile.set(site.file, after);
}
for (const [file, contents] of byFile) writeFileSync(at(file), contents);

for (const { site, value } of readAll()) {
  console.log(`  ${site.label.padEnd(42)} ${value}`);
}
console.log(`\n✓ set to ${version} build ${build} in ${byFile.size} files (${SITES.length} places)`);
console.log('  iOS/Android are committed prebuild artefacts — commit them with the config.');
