# Mobile version of checklister

設計與待辦見 `mobile/Plan.md`；已 ship 與踩坑紀錄見 `mobile/Update_log.md`；
參考文件在 `mobile/docs/`。

## 開發

```bash
cd mobile/app
npx expo start --dev-client --clear
npx tsc --noEmit          # 改完一定要跑
```

## Build

```bash
# iOS（加 native module 後必跑）
npx expo run:ios

# Android
npx expo prebuild --platform android
npx expo run:android
```

## 常用 shell alias

存進 `~/.zshrc` 後 `source ~/.zshrc`：

```bash
alias chk-metro='lsof -ti :8081 | xargs kill -9 ; sleep 1 ; cd ~/Documents/applications/checklister-ng/mobile/app && npx expo start --dev-client --clear'
alias chk-reload='xcrun simctl terminate booted tw.checklister.mobile ; xcrun simctl launch booted tw.checklister.mobile'
alias chk-reset='xcrun simctl uninstall booted tw.checklister.mobile'
alias chk-build='cd ~/Documents/applications/checklister-ng/mobile/app && npx expo run:ios'
```

| 狀況 | 用哪個 |
|---|---|
| Metro 卡 / 新檔案沒抓到 | `chk-metro` |
| App crash 想重啟 | `chk-reload` |
| 想清掉本機資料測試 | `chk-reset && chk-build` |
| 加新 native module 後 | `chk-build` |

> bundle id 仍是 `tw.checklister.mobile`（顯示名稱是 Mitalivana，識別碼刻意不改）。
