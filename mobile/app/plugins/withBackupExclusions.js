/**
 * Keep "large files we can fetch again" out of the system backup (Android side).
 *
 * Why this is not optional: Android Auto Backup allows 25 MB per app. Leaving
 * the RudyMap offline tile packages (gigabytes) or the TaiCOL bundle DB (157 MB)
 * inside the backup set makes **the whole backup fail** — taking user.db, which
 * genuinely should be backed up, down with it. This is not an optimisation, it
 * fixes a regression that appears as soon as a tile package exists.
 *
 * Why a config plugin instead of editing AndroidManifest.xml directly:
 * `mobile/app/android` is ignored by the root .gitignore (line 88) and is a
 * prebuild artefact, so a hand edit disappears on the next prebuild.
 *
 * iOS is not here: its exclusion is the runtime NSURLIsExcludedFromBackupKey
 * file attribute, not a build-time setting, and a config plugin cannot set it
 * (see the native module under modules/).
 */
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * These paths are relative to the app's filesDir (expo-file-system's
 * Paths.document).
 *
 * There is one criterion: **anything re-downloadable stays out of the backup**.
 * The list has to track the root-directory constant of each install layer, so
 * new downloadable content must be added here — missing one large directory is
 * not "one thing less in the backup", it is the whole Auto Backup exceeding the
 * 25 MB quota and **failing entirely**.
 */
const EXCLUDED = [
  'datasets', // src/db/datasets.ts DATASETS_DIR — checklist modules; Taiwan alone is 136 MB
  'vectormap', // src/lib/vectormap.ts ROOT_DIR — vector tiles, gigabytes
  'poi', // src/lib/poi.ts ROOT_DIR
  'rudymap', // src/lib/poi.ts LEGACY_DIR — leftovers from older installs, cleared by poi.ts
  'regionpacks.db', // Country checklist pack, re-downloadable; the in-app backup zip carries it
  'regionpacks.db-wal',
  'regionpacks.db-shm',
  'twnamelist.db', // The merged file from before 0.5; still present where retireLegacyBundle() has
  // not run yet
  'twnamelist.db.version',
];

const DATA_EXTRACTION_RULES = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
${EXCLUDED.map((p) => `    <exclude domain="file" path="${p}" />`).join('\n')}
  </cloud-backup>
  <device-transfer>
${EXCLUDED.map((p) => `    <exclude domain="file" path="${p}" />`).join('\n')}
  </device-transfer>
</data-extraction-rules>
`;

// Android 11 以下走舊的 fullBackupContent，根元素不同，不能與上面共用一個檔案。
const FULL_BACKUP_CONTENT = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
${EXCLUDED.map((p) => `  <exclude domain="file" path="${p}" />`).join('\n')}
</full-backup-content>
`;

const withBackupRuleFiles = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      const xmlDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml',
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'data_extraction_rules.xml'), DATA_EXTRACTION_RULES);
      fs.writeFileSync(path.join(xmlDir, 'backup_rules.xml'), FULL_BACKUP_CONTENT);
      return cfg;
    },
  ]);

const withManifestAttrs = (config) =>
  withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
    app.$['android:fullBackupContent'] = '@xml/backup_rules';
    return cfg;
  });

module.exports = (config) => withManifestAttrs(withBackupRuleFiles(config));
