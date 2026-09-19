/**
 * 把「可重新取得的大檔」排除在系統備份之外（Android 側）。
 *
 * 為什麼一定要做：Android Auto Backup 每個 app 的配額是 25 MB。魯地圖離線圖磚
 * 包（GB 級）與 TaiCOL bundle DB（157 MB）留在備份範圍內會讓**整個備份失敗** ——
 * 也就是連 user.db 這種真正該備份的資料都一起壞掉。這不是最佳化，是修一個
 * 加了圖磚包就會出現的回歸。
 *
 * 為什麼是 config plugin 而不是直接改 AndroidManifest.xml：`mobile/app/android`
 * 在根 .gitignore 第 88 行被忽略，是 prebuild 產生物，手改會在下次 prebuild 消失。
 *
 * iOS 不在這裡：iOS 的排除是 runtime 的 NSURLIsExcludedFromBackupKey 檔案屬性，
 * 不是建置期設定，config plugin 設不了（見 modules/ 底下的原生模組）。
 */
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/** 這些路徑相對於 app 的 filesDir（expo-file-system 的 Paths.document）。 */
const EXCLUDED = ['rudymap', 'twnamelist.db', 'twnamelist.db.version'];

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
