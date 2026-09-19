import { requireOptionalNativeModule } from 'expo-modules-core';

type BackupExclusionModule = {
  exclude(uri: string): boolean;
};

/** Android 沒有這個模組，dev client 還沒重建時 iOS 也沒有 —— 兩種情況都回 null。 */
const native = requireOptionalNativeModule<BackupExclusionModule>('BackupExclusion');

/**
 * 把某個檔案或目錄標記為不進 iOS 備份。回傳是否真的設定成功。
 *
 * 呼叫端**不應該**因為回傳 false 就中止：Android 走的是建置期的 backup_rules.xml
 * （plugins/withBackupExclusions.js），這裡本來就會是 false。
 */
export function excludeFromBackup(uri: string): boolean {
  return native?.exclude(uri) ?? false;
}
