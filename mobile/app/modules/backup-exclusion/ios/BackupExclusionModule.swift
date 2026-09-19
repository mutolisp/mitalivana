import ExpoModulesCore

/**
 * 把「可重新取得的大檔」標記為不進 iCloud／iTunes 備份。
 *
 * 為什麼需要原生程式碼：iOS 的排除是檔案系統屬性 `NSURLIsExcludedFromBackupKey`，
 * 要在 runtime 對實際路徑設定，不是建置期設定 —— config plugin 做不到，而
 * expo-file-system@19 也沒有對應 API（整個套件搜尋 excludeFromBackup 零命中）。
 *
 * 為什麼不乾脆放 Library/Caches（那裡本來就不備份）：iOS 在磁碟吃緊時會清掉
 * Caches，而且 app 沒在跑也會被清。幾 GB 的離線地圖在上山前一晚消失，對野外
 * 調查是不能接受的失敗模式。
 *
 * Android 不需要這支：那邊的排除是建置期的 backup_rules.xml，由
 * plugins/withBackupExclusions.js 處理。
 */
public class BackupExclusionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BackupExclusion")

    Function("exclude") { (uri: String) -> Bool in
      // 呼叫端給的是 expo-file-system 的 file:// URI；也接受純路徑。
      let url = uri.hasPrefix("file://")
        ? URL(string: uri)
        : URL(fileURLWithPath: uri)
      guard var url else { return false }

      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      do {
        try url.setResourceValues(values)
        return true
      } catch {
        // 檔案還不存在或屬性設不了都不該讓下載流程中斷 —— 呼叫端只把回傳值
        // 當成「有沒有成功」的資訊，不據以中止。
        return false
      }
    }
  }
}
