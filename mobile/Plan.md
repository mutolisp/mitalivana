# Checklister Mobile 設計文件

## 原始需求

1. 具有和 checklister 搜尋相同的功能
2. 可建立名錄 (species richness)、物種豐度 (abundance) 等功能
3. 具有匯出名錄、物種豐度等功能
4. 有地圖功能，可記錄點位和錄製軌跡
5. 支援 iOS / Android

## 文件地圖

| 檔案 | 裝什麼 |
|---|---|
| `Plan.md`（本檔） | **待辦** ＋ 現行架構與長效設計決策 |
| `Update_log.md` | 已 ship 與踩過的坑；附錄 A–D 收了本檔原本 4,000 多行的 sprint 推導過程 |
| `Device_test.md` | 實機驗證清單（171 項，全部未跑）。**驗證項不要寫回本檔** |
| `docs/` | 仍代表現況的參考文件：檢索表、樣區、匯出外部 API、報表、物種詳細頁、地圖、i18n |
| `docs/planned/` | 純規劃未動工：AI 辨識、P2P 協作、雲端協作 |
| `archive/` | 已完成或被取代的設計稿與一次性稽核 |
| `PRIVACY.md` / `PRIVACY.en.md` | 隱私政策 |

各領域的現行設計決策不重複寫在這裡，去對應的 `docs/` 檔看：
樣區調查 → `docs/Survey_plots_plan.md`；檢索表 → `docs/Ident_keys.md`；
地圖與圖層 → `docs/Map.md`；iNat／GBIF → `docs/External_species_api.md`；
報表 → `docs/Report.md`；物種詳細頁 → `docs/Species_details.md`；i18n → `docs/i18n.md`。

---

## 待辦

> 2026-09-22 全面查證後重新分類。舊版散在各 sprint 的 248 個 `[ ]` 裡，有 16 項其實
> 早就做完（落點見 `Update_log.md` 附錄 C 的原始清單），171 項是實機驗證（已移到
> `Device_test.md`），其餘就是下面這些。

<details>
<summary><b>那 16 項「標著 <code>[ ]</code> 但其實早就做完」的落點</b>（2026-09-22 查證）</summary>

`Update_log.md` 附錄 C 保留了原始清單的**原樣**（含未打勾的方框），因為那是當時的紀錄。
現況以這張表為準：

| 原條目 | 落點 |
|---|---|
| 物種詳細頁 → 檢索表 deeplink | `src/components/SpeciesDetailSheet.tsx:318-346` |
| 鍵盤遮擋輸入框／儲存鈕 | 7 個 `KeyboardStickyView` 呼叫端 ＋ `scripts/check-bottom-dock.mjs` |
| Phase 2.0 地圖 10 項（滿版／WMTS／view state／sites CRUD／KML-GPX-WKT／權限文案） | `app/(tabs)/map.tsx`、`src/db/sites.ts`、`src/lib/geoConverters.ts`、`geoExporters.ts` |
| 離線地圖更新機制 | `src/lib/vectormapInstall.ts:149-154`（已從 raster 改為 pmtiles） |
| 匯出時把 lat/lng/notes 嵌進複本 JPEG | `src/lib/bundleExport.ts` 的 `restamped()` |
| TaiCOL 資料更新機制 | `src/lib/datasetInstall.ts:130 hasUpdate()` |
| 分類樹展開狀態 persist | `src/stores/settings.ts` 的 `taxonomy_expanded` |
| 樣區物種照片 | `src/db/plots.ts:189` ＋ `PlotSpeciesValueModal.tsx` |
| 檢索表 5-4 離線快取 ＋ 重新下載 | 已由 `tw-keys` 模組取代（`src/db/keys.ts:1-13`、`app/regionpacks.tsx:458-575`） |
| Step 6 前三項 contextual entry point | `taxonomy.tsx:1071-1132`、`SpeciesDetailSheet.tsx:144-179`、`PlotSpeciesValueModal.tsx:250-275` |
| taxon 解析收斂到 `taxonLookup.ts` | 已收斂，三個呼叫端都 import |
| `map.tsx` 的 `Platform` import 未使用 | 已移除 |
| `scientificNameAuthorship` 三處修正 | `mapper.py:15`、`dwcMapper.ts:10`、`search_api.py:156,202`；IUCN 欄名也已對齊 |
| 地圖只畫 active session 的點位 | 已改 `pointsSessionId`（`map.tsx:372-373`） |
| 與 web 版「名錄比較」對齊 | 已由 report 的 Sørensen／Jaccard 矩陣涵蓋（`reportModel.ts:738-775`） |
| i18n 英／日 | 已有 8 語系（含 es-419） |

兩處是**文件要改、程式不用改**：`key_sheet_import.py` 的 multi-access worksheet 慣例是
**`Genus_m` 後綴**（`:67 MATRIX_SUFFIX`），不是舊文件寫的 `multi:Genus`；分類樹 🔑 icon
是**按 key mode 分色**（二分／多入），不是「線上 vs 已快取」——模組化後沒有「線上」這個狀態。

</details>

### A. 正確性缺口 — ✅ 全部完成 2026-09-22

| # | 問題 | 修法與落點 |
|---|---|---|
| A1 | **檢索表 alias 索引掛錯 rank**：`buildIndex` 把 alias 索引在 key 自己的 `scope_rank` 底下，於是 Davalliaceae（family key）上掛的 `Davallia` 被存成 `family:Davallia`，而呼叫端查的是 `genus:Davallia` → 查不到。7 份帶 alias 的 key 有 5 份完全失效 | alias 改用 rank-agnostic 的 `ALIAS_RANK` 桶，`getKeysForScope` 回傳「exact rank 優先 ＋ alias 補上、依 id 去重」。`src/db/keys.ts:130-207`。對真的 `tw-keys` 模組（896 份 key）實跑：5 個原本查不到的單屬科現在都找得到（Dioscorea / 竹亞科 / Davallia / Woodsia / Nephrolepis），Selaginella 與 Asplenium 各多一份不同書的 family key，896 份 key 的自身 rank+name 查詢無一改變 |
| A2 | 詳細頁「最後更新」恆為 undefined | SELECT 清單補 `updated_at`：`src/db/records.ts:275`、`src/db/collections.ts:121`。樣區走 `SELECT *` 本來就有 |
| A3 | 檢索表三個 toast 在自己的 Modal 裡看不見 | 改 `Alert`；成功那個保留「前往記錄」做為 Alert 按鈕（這張 Modal 加入後沒有任何視覺變化，拿掉等於零回饋）。`src/components/KeyMatrixRunner.tsx:225-252`，順手移除孤兒 `useToast` import |
| A4 | 重新鑑定換了學名卻還掛前一位鑑定者，且沒有鑑定日期 | **migration v40** 加 `collection_specimens.date_identified`（ISO `YYYY-MM-DD`）。`updateSpecimenTaxon` 同時寫入預設鑑定者與今日；`addSpecimen` 用採集日。型別／`SPECIMEN_COLS`／`SPECIMEN_UPDATABLE_KEYS`／`dwcMapper`（→ `dateIdentified`）／`bundleYaml` 都接上。scratch DB 實跑：既有列取得 NULL、重跑 v40 冪等 |
| A5 | 匯出大小預估在 iOS 永遠落回 3 MB 啟發值 | `mediaAssetTarget()` 從 `bundleExport.ts` 抽出共用，`exportSize.ts` 改用它；`file://` 改以 `expo-file-system` 直接量，catch 補 dev warn |
| A6 | 名錄記錄全都沒座標時地圖一片空白 | `shownSessionNoCoords` ＋ 一列提示橫幅（`app/(tabs)/map.tsx`）。訊息刻意不帶數量：i18next 的 `count` 會觸發複數，而數字本來就在記錄列表 |
| A7 | iOS 權限文案仍寫「Checklister」 | `app.config.ts` 7 條改 Mitalivana。**注意**：committed 的 `ios/…/Info.plist` 早已是 Mitalivana（手改過），所以這是**防下次 prebuild 洗回去**，不是使用者現在看得到的錯 |
| A8 | 版本號三處不一致 | `project.pbxproj` CURRENT_PROJECT_VERSION 19 → **20**（對齊 `CFBundleVersion`）；`package.json` `1.0.0` → `0.5.1` |
| A9 | 外部物種的 DwC `taxonID` 輸出本地鑄造 id，接收端無法解析 | 新增純模組 `src/lib/taxonId.ts`：`publishedTaxonId()` 把 `g…`→GBIF URI、`gi…`→iNat URI、`gm…`→空字串，`t…`/`y…` 原樣。**只用在 DwC-A**（`dwcRows.ts` 三處）——yml 與 CSV 是我們自己的 round-trip 格式，`sessionImport.ts` 會把 `taxonID` 讀回來重建記錄，改成 URI 會炸掉匯入。`db/regions.ts` 的 `isExternalTaxonId` 改為 delegate 到同一支純模組，前綴語意只剩一份定義。`check:dwc` 加 7 條斷言（故意改壞可重現失敗） |
| A10 | backend `Form` / `Forma` 不一致：`taxonomy_api.py` 8 處只認 `Form`，`qa_api.py` 4 處認兩者 | 新增 `backend/utils/ranks.py`（`SPECIES_LEVEL_SQL` / `INFRASPECIFIC_SQL`），12 處全部改用。對真 DB 驗證四組計數修前後完全一致（69,159 / 4,281 / 10 / 20,565）——TaiCOL 目前只有 `Form`（3,003 筆）、`Forma` 0 筆，所以這是防禦性統一，不動既有數字 |

> 順手修掉一個**既有的紅燈測試**：`tests/test_regression.py::test_export_csv_dwc_headers` 斷言
> `nationalRedListCategory`，而 2026-09-16 起紅皮書已改輸出 `threatStatus`（`mapper.py:37`）。
> 指向不存在詞彙的守門等於沒有守門。改完 backend `pytest` 30 passed / 1 skipped。
>
> **未處理、但查證時發現的**：`taicol_names.rank` 另有 `Subform` / `Subvariety` /
> `Nothosubspecies` / `Nothovariety` / `Special Form` / `Race` / `Morph` / `Lusus` /
> `Aberration`，兩支 API 至今都把它們排除在「物種階層」之外。要不要納入會改動已發布的數字，
> 是資料決策不是清理，理由記在 `backend/utils/ranks.py` 的 docstring。

### B. 匯出完整性（也是出處驗證的前置）

> **B1 完成 2026-09-22。** 三個純函式進 `src/lib/dwcMultiValue.ts`：
> `establishmentMeansDwcValue`（**控制詞彙**，7 個允許值釘在
> `scripts/vocab/establishment-means-values.json`，2026-09-22 從 GBIF vocabulary API 取得）、
> `higherClassificationOf`、`individualCountOf`。`check:dwc` 加了 30 條斷言把規則釘死。
>
> 兩件查證後推翻原判斷的事：
>
> - **`leafPhenology` 不是缺口。** 它沒有 DwC 詞彙（`check-dwc-terms.mjs:67` 早就列為
>   app-specific），而 meta.xml 每個欄位都必須帶真實 term URI，所以 archive 排除它是對的。
>   它留在 CSV 與 yml —— 那裡才允許非標準欄位。
> - **`scientificNameID` 做不了。** `name_id` 不在 `taxonLookup.ts` 的 `TAXON_COLS` 裡，
>   資料根本沒被讀出來。原清單寫「資料也都有」對這一欄是錯的。要做得先擴 `TAXON_COLS`。
>
> **`associatedMedia` 也未做**：照片檔名是 `bundleExport.ts` 算的，`dwcRows.ts` 拿不到
> （反向 import 會成環）。要嘛把檔名 resolver 傳進去，要嘛把命名邏輯抽成純模組。獨立一刀。
>
> 守門自己抓到一個我寫錯的地方：`Number('')` 是 0，所以「沒填數量但單位是 individuals」
> 原本會輸出 `individualCount=0` —— 那是在宣告「數到零隻」，與「沒有資料」相反。已修。

| # | 項目 | 落點 |
|---|---|---|
| B1 ✅ | `OCCURRENCE_COLS` 20 → **35 欄**（archive 總欄數 44 → 59）。新增：`taxonRank` `higherClassification` `phylum` `class` `order` `genus` `taxonomicStatus` `acceptedNameUsage` `acceptedNameUsageID` `establishmentMeans` `individualCount` `recordNumber` `identifiedBy` `dateIdentified` `modified`（後者是 Dublin Core，`dwc:` 沒有這個詞彙）。三個 builder 全部填值，實際產一份 archive 逐欄驗過、meta.xml 也宣告了 | `src/lib/dwcArchive.ts`、`src/lib/dwcRows.ts` |
| B2 | 保育狀態 Distribution extension（`threatStatus` / `appendixCITES`）：meta.xml 目前只有 Occurrence ＋ eco:Event | `src/lib/dwcArchive.ts` |
| B3 | manifest 內嵌媒體 sha256（每檔 `{path, bytes, sha256}`），讓 yml 單獨拿出來就能驗照片／錄音位元 | `src/lib/bundleExport.ts:370`（型別）、`:742/:967/:1113`（產生點） |

### C. 出處驗證：數位簽章 ＋ ORCID

**目標**：讓拿到檔案的人能確認「這是某人實際調查的 raw data」，而且那個人確有其人。
不是防竄改的法律級簽章，是出處證明。

已定的範圍與決策：

- **只做 mobile**；驗證端 = CLI ＋ 一段 Python ＋ 一頁單檔 HTML（**不維護伺服器**）。
- **簽 `manifest.json` 的 canonical JSON**，manifest 內含每個檔案的 sha256（B3）。
  yml 的 key 順序與浮點格式**因此不必定死**——yml 的位元由它自己的 sha256 釘住。
  照片與錄音同理，所以「每張照片各自可驗」與「每次匯出可驗」用同一把簽章滿足。
- **Ed25519**（`@noble/ed25519` ＋ `@noble/hashes`，純 JS）。金鑰種子用**既有的 SQLite
  `randomblob()`** —— `src/db/uuid.ts` 檔頭已寫明選它正是為了避免加 `expo-crypto`
  這個 native module。**整套零 native rebuild。**
- **私鑰放 `expo-secure-store`**（已安裝），**不進備份 zip、不上 Drive**。
  換機就重新產一把；ORCID profile 上累積多把公鑰、舊的不刪，所以舊簽章永遠驗得過。
- **ORCID 綁定**：公鑰寫進 ORCID public profile 的 Websites & social links（`ed25519:<base64>`）。
  信任鏈到「ORCID 帳號沒被盜」為止，驗證端輸出要明講。app 內只做「填 ORCID →
  顯示待貼上的公鑰 → 給 profile 連結」，**不代寫 ORCID**（需 member API）。
- **重新編碼過的照片**（LINE、雲端縮圖）sha256 必然對不上。驗證端要報「這張照片與簽章時
  不同」，不是「簽章無效」。
- 守門 `check:sign`：canonical JSON 排序規則、manifest↔簽章互為反函式、
  未設金鑰時不得夾帶半套 `.sig`。

### D. 技術債

| # | 項目 | 落點 |
|---|---|---|
| D1 | 34 處 `e instanceof Error ? … : String(e)` 在 catch 裡讓 React Compiler bail out 整個元件。抽共用 `errText`，**單獨一輪、不混功能改動** | 20 個檔案；`PhotoImportModal.tsx:37` 有區域版本 |
| D2 | `markSensuLato()` 每列一次 LIKE（Mac 約 17 ms/列，實機數倍）。改前後都要看 `EXPLAIN QUERY PLAN` | `src/db/search.ts:153-171`，呼叫端 `:527` |
| D3 | `useMemo(() => { setState(...); return null; })` 在 render 階段寫 state（2026-05 的 v12 review 就點名過） | `PlotSpeciesTab.tsx:126-130, 158-162` |
| D4 | Vision 移除後的三處孤兒：`babel.config.js:9-15` 的 `react-native-worklets-core/plugin`、`package.json:96` 的相依（**別誤刪 `react-native-worklets`，那是 Reanimated 4 在用**）、`settings.ts` 的 `ai_geomodel_filter` | — |
| D5 | 死碼：`keys.ts:330 findSubkeyForTaxon` / `findSubkeyByScopeName` / `findSubkeyFromLeadText` 生產端零呼叫（A1 修好後可考慮改用它們而非刪）；`app/(tabs)/index.tsx clearChao2ChipCache` 是 dead export | — |
| D6 | 兩套 rank chip 並存：`SpeciesDetailPanel.tsx` 用自家 `RankChipRow`，其餘三處用共用 `TaxonomyJumpChip.tsx` | — |
| D7 | v13 的 legacy 欄位 `plot_surveys.e0_*..e3_*` 始終沒 drop，UI 層已無人使用 | `migrations.ts:200-212`、型別 `plots.ts:145-157` |
| D8 | migration 沒有 transaction 包覆，partial fail 會留半套狀態 | `src/db/migrations.ts` |
| D9 | 匯出檔名用 `plot.start_ts ?? Date.now()`，未開始的樣區每次匯出拿到不同日期。應改 `created_at` | `bundleExport.ts:801` |
| D10 | `ios/Podfile` 的 `post_install` 最低部署版本區塊會被 prebuild 洗掉，要做成 local config plugin | `plugins/` 旁 |
| D11 | 向量地圖 pipeline 沒有 make target（`backend/scripts/rudymap/vector/` 13 支只在 README:326-355 記手動指令；Makefile 仍只有舊 raster 的 `rudymap-*`） | — |
| D12 | `gps_mode` 從未被寫成 `'single_point'` | `app/session/[id].tsx:479-493` |
| D13 | `check:dock` 只涵蓋 `KeyboardStickyView`，不管四個 `KeyboardAvoidingView` modal | `scripts/check-bottom-dock.mjs:54` |
| D14 | `identification_keys.scope_name` 有 13 個不是 accepted Genus（字串連結、不在 stale check 守備範圍，數字未惡化 14→13，觀察即可） | backend |

### E. 功能缺口（依「擋住多少實際使用情境」排序）

1. **採集 round-trip 匯入** —— 三種記錄只有它不能還原。`recordImportZip.ts:199` 仍 throw
   `unsupportedCollection`，`check-roundtrip.mjs:584-592` 反向釘死要一起改。
2. **行程層級 `locality` 編輯入口** —— `TRIP_UPDATABLE_KEYS` 已含此欄，純缺 UI；
   標籤的 Location 目前只能逐筆填。
3. **名錄端 abundance UI** —— `records.ts:158-168 updateRecordQuantity` 零呼叫端，DB 層備妥。
4. **標本複份 ＋ `institutionCode` / `otherCatalogNumbers`** —— 完全沒有欄位，要 migration。
5. **採集行程綁 Site** —— `collection_trips` 沒有 `site_id`，`SiteAssignSheet` 可沿用。
6. **照片來源擴充到檔案 App / iCloud**（Phase 3c）—— 相簿路徑（3b）已上線。HEIC 在這條路
   沒有 picker exif 可用，`piexif.js:480-492` 的格式閘門只收 JPEG／TIFF／裸 Exif blob，
   一定 throw；是整個 Phase 3 最難的一塊，而它擋不住大多數實際情境。
7. **分類樹**：病毒 realm 階層（`src/db/taxonomy.ts:269-284` 仍 `kingdom NOT IN (VIRUS_KINGDOMS)`）、
   批次加入（`BatchImportModal` 未掛到分類樹）。
8. **樣區**：capture GPS → 自動建 Point site（`app/plot/[id].tsx:354-377` 只 patch 座標）、
   protocol / sample size 偏好記憶、同樣區重複測量模型（v39 為止沒有 `visit_number` 之類欄位）。
9. **檢索表**：5-5 殘項（feature 依 `category` 分組摺疊、固定頂部已選 chip 列）、
   5-6 全部（feature 搜尋、entropy 排序、Help me decide）、「目前僅維管束植物」提示、
   §6.4 IK 辨識重點 stages 1–5（`key_summary.py` 與 `identification_keys.summary` 皆不存在）、
   進檢索表 segment 時自動比對模組更新。細節見 `docs/Ident_keys.md`。
10. **地圖**：採集記錄與樣區逐筆物種點上圖（`plot_species_records.lat/lng` 自 v13 只寫不讀）、
    plots／sessions／sites 三層的圖層開關、保育區位 GIS 面圖層（`LayerSheet` 目前只吃
    WMTS raster，無 vector polygon overlay infra）。細節見 `docs/Map.md`。
11. **報表 R6**：拆分 `check-report.mjs`（約 1,840 行）、UPGMA 分群樹（建議不做，理由見
    `docs/Report.md` §8-3）。
12. **Backend admin PDF 上傳 UI ＋ sheets sync 按鈕** —— 端點 `keys_api.py:192-249` 早就在，
    `frontend/src/routes/admin/+page.svelte` 只有 CSV 匯入。
13. **跨裝置同步／協作** —— Drive 備份只是換機搬家，不是同步。見 `docs/planned/Online_collaboration.md`
    Phase 0/2/3 與 `docs/planned/P2P_collaboration.md`（兩者的「合併引擎」是同一件工作）。
14. **背景定位** —— `trackRecorder.ts:131` 只有前景 `watchPositionAsync`。野外電力有限，
    先評估是否真的需要。
15. **AI 物種辨識** —— 前提是使用者自訓 TaiCOL 模型，在那之前不動工。見 `docs/planned/Vision_model.md`。

### F. 發布

#### Play Store 上架（queue，預估 1-2 週含填表與 Google 審核）

- [ ] **Google Play Console 帳號**：$25 USD 一次性註冊費，個人開發者帳號
- [ ] **產 production AAB**：`make build-android-prod`（Play Store 接受 AAB 不是 APK）
- [ ] **Play Console 建 app**：名稱、套件名 `tw.checklister.mobile`、類別、預設語言（zh-TW）、
      隱私政策 URL（`PRIVACY.md` 已有草稿，需要一個永遠可訪問的網址）
- [ ] **商店素材**：icon 512×512、feature graphic 1024×500、手機截圖至少 2 張（建議 4-8）、
      簡短描述 ≤ 80 字、詳細描述 ≤ 4000 字
- [ ] **資料安全宣告**（Google 嚴格審）：收集哪些資料（位置／照片／device ID 都要列）、
      為什麼收、是否分享第三方（Google Maps、TaiCOL／GBIF／iNat API）、是否加密傳輸
- [ ] **內容分級**（IARC 問卷）、**目標受眾**、三項申明（新聞／COVID-19／政府 app，皆 No）
- [ ] **發布 track**：Internal Testing → Closed Testing（Google 審 14 天）→ Open Testing → Production
- [ ] **啟用 Play App Signing**
- [ ] `versionCode` 已是 2，`CFBundleVersion` 已是 20；上傳 TestFlight 前必須遞增

> iOS App Store 流程獨立（Apple Developer Program $99/年 ＋ TestFlight ＋ App Store Connect）。
> 商店列表名稱要在各自後台改成 Mitalivana，不是 commit 能處理的。
> `ios/Checklister.xcodeproj` / `ios/Checklister/` 目錄名仍是舊名，純內部路徑、改名要重簽
> provisioning profile，**刻意不動**。

#### 已知環境問題

- [ ] Xcode 26 + macOS 25.3 的 Cryptex disk image 機制需要手動 mount runtime 才能用 simulator（已解，文件記錄）
- [ ] Expo CLI 54.0.24 與 Xcode 26 的 `devicectl` JSON format 不相容，無法 `expo run:ios --device`，需從 Xcode 開 workspace build。SDK 升 55+ 應可解
- [ ] `expo-sharing` 必須裝 14.x（SDK 54 對應版本），裝到 55.x 會 build fail（type 不相容）

---

## 技術棧

| 項目 | 選擇 | 備註 |
|------|------|------|
| Framework | Expo SDK 54 + dev client | 比原 plan 的 SDK 52 更新，CI 與升級維護成本較低 |
| 語言 | TypeScript（strict）| |
| SQLite | `@op-engineering/op-sqlite` 15.x | JSI、`executeSync` 同步 API、效能優於 expo-sqlite |
| Navigation | Expo Router 6（typed routes 開啟）| 採檔案路徑 routing，比 React Navigation 較簡 |
| 樣式 | NativeWind 4 + Tailwind 3.4 | 與 web 版 Tailwind 風格一致 |
| State | Zustand 5 | 輕量、避免 Redux boilerplate |
| Gesture | `react-native-gesture-handler` 2.28 + `react-native-reanimated` 4.1 | Swipeable 移除手勢、bottom sheet 動畫 |
| Safe Area | `react-native-safe-area-context` | Modal 內用 `useSafeAreaInsets()` 手動處理 |
| 平台 | iOS + Android | MVP 只在 iOS Simulator 驗證，Android 待補 |
| Map (Phase 2) | `react-native-maps` + `@maplibre/maplibre-react-native` | 後者處理中研院 WMTS |
| OTA | `expo-updates` | JS 與小資源 OTA，DB 走獨立 download channel |
| Share | `expo-sharing` 14.0.8 | 系統 Share Sheet（必須對應 SDK 版本）|
| YAML | `js-yaml` | 與 backend `yaml.dump()` 兼容 |
| Fuzzy | `fastest-levenshtein` | 純 JS Levenshtein，配合預先 build 的 cname index |

## 資料策略

### TaiCOL 主資料

- **完整 bundle 進 APP**（157MB after VACUUM，2026-08-26 TaiCOL 版；原 118MB，隨名錄更新成長）
- 首次啟動：copy `assets/db/twnamelist.db` 到 `FileSystem.documentDirectory`，後續可寫
- **資料更新機制**：MVP 不做（無公開 server），Phase 2+ 再加

### 使用者資料

獨立 SQLite (`user.db`)，含 projects、sessions、checklist_records、settings、search_history、schema_version。

### Fuzzy Search Index

Server 端預先 build 候選 index（`backend/scripts/build_mobile_fuzzy_index.py`），存為 `cname_fuzzy_index` 表 bundle 進 TaiCOL DB。Runtime 只做查表 + Levenshtein 排序（62,809 unique cnames）。

## 資料模型 (MVP)

```
projects
├─ id (0 = 「未分類」固定 project)
├─ name
├─ abstract
├─ location_description
├─ notes
├─ created_at / updated_at

sessions
├─ id
├─ name (預設「YYYY-MM-DD HH:mm」可改)
├─ type ('checklist' | 'abundance')   ※ MVP 只實作 checklist
├─ project_id (FK, default 0)
├─ started_at / ended_at (NULL = active)
├─ gps_mode ('off'|'single_point'|'full_track')   Phase 2
├─ start_lat / start_lng                            Phase 2
├─ track_geojson                                    Phase 2
└─ notes

checklist_records
├─ id
├─ session_id (FK)
├─ taxon_id (FK to taicol_names)
├─ observed_at
├─ notes
├─ photo_paths (JSON array)   Phase 2
└─ lat / lng                  Phase 2

abundance_records (Phase 3，先預留)
├─ id, session_id, taxon_id
├─ method ('count'|'cover'|'braun_blanquet'|'domin'|...)
├─ value (REAL)
├─ unit / scale
├─ observed_at, notes, photo_paths, lat, lng

settings (key-value)
├─ language ('zh-TW' MVP only，i18n Phase 2+)
├─ theme ('light'|'dark'|'auto')
├─ undo_duration (5)
├─ card_density ('compact'|'comfortable')
├─ default_count_mode (Phase 3)
├─ last_search_group  ※ TaxonGroupPicker remember last
└─ last_search_query

search_history (recent 10 in 物種查詢頁)
├─ query
└─ searched_at
```

## 搜尋功能對齊清單

與 web 版功能完全對齊（已實作 ✅）：

1. ✅ 台 / 臺自動互換
2. ✅ Accepted-only（non-accepted 自動解析到接受名）
3. ✅ Fuzzy search（Levenshtein 距離 ≤2，預先 build 候選 index）
4. ✅ 排序優先級：cname 精確 → 學名精確 → cname 包含 → alt cname 精確 → alt cname 包含 → prefix → 長度
5. ✅ Nominal infraspecific 去重 + autonym s.l. / s.str. 標示（s.l. 標示用 `markSensuLato` 後處理）
6. ✅ 階層篩選（kingdom / class / order / family / genus）+ 進階篩選（特有 / 外來 / 紅皮書 / CITES / 保育類）
7. ✅ 同俗名替代俗名加括號
8. ✅ 同物異名命中用 `≡` 標示（單行 + tap 展開「你輸入：xxx」）
9. ✅ Fuzzy 命中用 `~` 標示
10. ✅ TaxonGroupPicker（14 類群）+ remember last（存 settings.last_search_group）

## Navigation 結構

### Bottom Bar

- **iOS**：`☰ 地圖(P2) [+] 名錄 分類樹(P2)`（FAB 凸出 +）
- **Android**：同上
- MVP 階段「地圖」「分類樹」disabled 顯示 placeholder

### Drawer-style Menu Tab (☰)

點選單 tab 進入 menu 頁，含：

- 專案管理 ✅
- 物種查詢 ✅（獨立搜尋入口，不歸屬任何 session）
- 匯出 ✅（YAML / CSV）
- 偏好設定 ✅
- 資料更新（Phase 2）
- 關於 ✅

### Active Session 頂部 Bar

有 active session 時固定在所有頁面頂部（用 `useSafeAreaInsets()` 處理動態島）：

```
● 記錄中：YYYY-MM-DD HH:mm
```

Tap 跳到當前 session 詳細頁。MVP 限制單一 active session。

### Stack Routes

| 路徑 | 內容 |
|------|------|
| `(tabs)/menu` | drawer-style 入口 |
| `(tabs)/index` | 名錄 tab（sessions 列表）|
| `(tabs)/map` | Phase 2 placeholder |
| `(tabs)/taxonomy` | Phase 2 placeholder |
| `(tabs)/plus` | redirect / FAB 觸發 |
| `session/[id]` | session 詳細頁 |
| `lookup` | 物種查詢頁 |
| `projects` | 專案管理頁 |
| `settings` | 偏好設定 |
| `about` | 關於 |
| `export` | 匯出（按 session 列表） |

## 主要畫面

### 1. 名錄 tab (Sessions 列表)

- 時間倒序、無分組
- Active session 醒目（綠點 + 「記錄中」tag）
- Row 顯示：時間、名稱（如不同於時間戳）、筆數 + project 名稱
- **Swipe-left → 紅色「刪除」** + confirm prompt（confirm 後刪除整個 session 含 records）
- Tap row → session 詳細頁
- 多選 → Phase 2

### 2. Session 詳細頁

```
┌─────────────────────────────────┐
│ ← 返回   [project name]   [結束]│  ← title 顯示 project（assigned）或時間戳
├─────────────────────────────────┤
│ 📁 蓮華池植物名錄 ▼      6 筆   │  ← 可 tap 開 ProjectAssignSheet
├─────────────────────────────────┤
│ [全部 6] [植物 6] ...           │  chip filter sticky
├─────────────────────────────────┤
│ 物種卡片：                       │
│  [照片] 大葉雀榕             NLC│
│         Ficus caulocarpa Miq.   │
│         桑科 Moraceae            │
│ ...                             │
├─────────────────────────────────┤
│ [▽ 維管束植物]                   │  TaxonGroupPicker
│ [輸入物種/分類群關鍵字...]       │  底部搜尋框
└─────────────────────────────────┘
```

**互動：**
- Tap 卡片 → 開 detail bottom sheet
- **Swipe-left → 紅色「移除」**（自動 + 5 秒 undo toast）
- Swipe-right → Phase 2（加備註 / 照片 / 重點）
- Tap 上方專案標籤 → ProjectAssignSheet（指派 / 新建專案）
- 右上「結束」→ B2 modal

**搜尋互動：**
- Autocomplete 最多 20 筆 scroll
- TaxonGroupPicker（14 類群）+ remember last
- Prefix match 優先
- 同物異名 `≡` 標示
- Fuzzy 命中 `~` 標示
- Tap row → 加入名錄 + Toast「已加入：xxx」5 秒可 undo
- 加入後：清空搜尋框 + 鍵盤保持開 + 焦點留搜尋框
- 搜尋框空字串時：顯示最近 5 筆 recent

### 3. Detail Bottom Sheet (tap 物種卡片)

```
─── (drag handle) ───
大葉雀榕                          [×]
Ficus caulocarpa Miq.
桑科 Moraceae
─────────────────────────────────
物種狀態
  [特有] [原生] [雜交]   棲地
保育狀態
  紅皮書 NLC · IUCN – · CITES – · 保育類 –
同物異名 (n)
  • Ficus xxx ...
此次紀錄
  時間：2026-05-11 09:13
  [編輯備註]    ← E2 全螢幕 modal
  照片  (Phase 2)
外部連結
  TaiCOL · GBIF · iNaturalist · Wikispecies
  植物加：IPNI · POWO
─────────────────────────────────
[ 從名錄移除 ]
```

### 4. 物種查詢頁 (drawer 入口)

獨立 search，不歸屬任何 session：

- 同 session 搜尋 UI
- Tap row → LookupResultSheet（同 detail sheet 但 action 改為「加到當前 session」）
- 沒 active session 時自動建 session 後加入
- 查詢歷史 recent 10 筆，獨立維護

### 5. ProjectAssignSheet（新增於 v0.1）

從 session 詳細頁頂部專案標籤觸發：

```
─── (drag handle) ───
指派專案
─────────────────────────────────
 [+] 新建專案     ← 跳 ProjectEditModal
─────────────────────────────────
📂 未分類 ✓
📁 蓮華池植物名錄
📁 浸水營植物相
...
─────────────────────────────────
```

選擇後立即 update session.project_id + reload + toast 「已更新專案」

### 6. 結束 Session 流程 (B2 modal)

按右上「結束」後跳全螢幕 modal：

```
結束記錄？
共 6 筆 · 歷時 1 小時 23 分鐘

名稱：[2026-05-11 07:10 ____]
專案：[蓮華池植物名錄 ▼]
備註：[____]

[取消]  [結束]
```

未結束的 session 隔日自動 prompt（TODO）

### 7. 偏好設定 (MVP)

- 主題（淺 / 深 / 跟隨系統）
- Toast undo 時長（5 / 8 / 10 秒）
- 物種卡片密度（緊湊 / 寬鬆）
- 清除查詢歷史
- 清除所有資料（雙重 confirm，目前 placeholder）

### 8. Empty States

| 畫面 | 文字 |
|------|------|
| 名錄 tab 無 session | 「還沒有任何記錄。按下方 + 開始第一筆名錄」+ 大 + icon |
| Session 內無物種 | 「按下方搜尋框找物種加入名錄」+ 搜尋 icon |
| Search 無結果 | autocomplete 為空（fuzzy 已嘗試）|

## 互動慣例

| 動作 | 行為 |
|------|------|
| Tap 物種卡片 | 開 detail bottom sheet |
| Long-press 物種卡片 | Phase 2 quick action menu |
| Tap autocomplete row | 加入名錄（明確意圖）|
| **Swipe-left** | **刪除 / 移除（紅 + trash icon + undo toast）** |
| Swipe-right | Phase 2 非破壞性操作 |
| Tap 頂部 active bar | 跳到當前 session |
| Tap session header 專案標籤 | 開 ProjectAssignSheet |
| Tap detail sheet 外部連結 | 開系統瀏覽器 |
| Pull-down on bottom sheet | 關閉 sheet |
| Tap modal 半透明背景 | 關閉 modal |

## App 啟動流程

- **首次啟動**：DBProvider copy TaiCOL DB 到 documentDirectory，runUserMigrations 建表（含預設 project id=0「未分類」），載入 settings → 進主畫面
- **不做 onboarding**：直接進主畫面
- **首次按 +**：直接建 session，預設 project_id = 0
- **之後按 +**：B1 零步驟，直接開 session 進搜尋畫面
- **記住上次 TaxonGroup**：last_search_group 存 settings，SearchBox 載入時恢復

## 匯出

| 格式 | 狀態 | 備註 |
|------|------|------|
| YAML | ✅ MVP | 與 web 版 byte-level 相容（透過 dwcMapper 對應）|
| CSV | ✅ MVP | DwC 36 欄 + UTF-8 BOM |
| Markdown | ✅ MVP | 維管束植物 6 類群分流、autonym s.l./s.str.、保育統計、計畫 header |
| DOCX | **永久 N/A** | pandoc 無法 bundle，請用 web 版開 YAML 轉 |

匯出後透過 `expo-sharing` 開系統 Share Sheet（傳 LINE / email / AirDrop / 存到 Files）。

## 學名 italic 規範

由 `<ScientificName>` 元件統一處理，UI 與 Markdown 兩端規則一致：

| 元素 | Italic | 說明 |
|------|--------|------|
| 屬名（Genus）| ✅ | 例：*Quercus* |
| 種小名（specific epithet）| ✅ | 例：*glauca* |
| 種下小名（subordinate epithet）| ✅ | 例：*amamiana* |
| Rank 縮寫 `var.` `subsp.` `ssp.` `f.` `fo.` `×` | ❌ | 中間斷開斜體 |
| 命名者（author）| ❌ | 例：(Hayata) Hayata |
| 科名拉丁（family）| ❌ | 例：Fagaceae |
| 目 / 綱 / 門 / 界拉丁 | ❌ | |
| 中文俗名 / 中文階層名 | ❌ | 例：殼斗科、被子植物門 |

動物（kingdom = `Animalia` 或 nomenclature = `ICZN`）：trinomial 全 italic（`*Panthera tigris altaica*`），無 rank 縮寫。

植物 / 真菌 / 預設：epithet 級分割 italic（`*Quercus glauca* subsp. *amamiana* Hayata`）。

## 風險與待解問題

1. **TaiCOL DB 體積**：✅ 原 118MB 可接受，已驗證 simulator 能跑；2026-08-26 名錄更新後為 **157MB**，仍在可接受範圍但需留意成長
2. **匯出格式一致性**：✅ YAML / CSV 對齊 backend dwc_field_map
3. **Fuzzy search 效能**：✅ 預先 build cname_fuzzy_index 表，runtime ~10-30ms
4. **iOS / Android UI 差異**：⏰ Android 還沒驗證
5. **沒有公開 server**：⏰ 資料更新、跨裝置同步皆受限
6. **Xcode 26 + Expo CLI 54 不相容**：⏰ `expo run:ios --device` 失敗，目前透過 Xcode workspace build 繞過
7. **免費 Apple ID 簽署 7 天過期**：⏰ 野外長期測試需 Apple Developer Program ($99/年)

## 開發 / Build 速查

```bash
# 開發
cd mobile/app
npx expo start --dev-client --clear     # Metro，加 --clear 清快取
npx expo run:ios                        # 第一次或加新 native module 後重 build

# 加 native module 流程
npx expo install <package>              # 自動裝對應 SDK 版本
cd ios && pod install                   # 安裝 native pods
cd .. && npx expo run:ios               # 重 build（吃約 3-5 分鐘）

# Fuzzy index 重 build（若 TaiCOL 更新）
cd /path/to/checklister-ng
backend/venv/bin/python backend/scripts/build_mobile_fuzzy_index.py mobile/app/assets/db/twnamelist.db

# Type check
cd mobile/app && npx tsc --noEmit
```

## EAS Build（推實機 / 上架用）

`eas.json` 已建好，含 development / development-sim / preview / production 4 個 profile。第一次使用前要：

```bash
# 1. 安裝 EAS CLI（全域）
npm i -g eas-cli

# 2. 登入 Expo 帳號（需要 Expo account）
eas login

# 3. 在 mobile/app 目錄初始化 EAS project（會寫入 app.json extra.eas.projectId）
cd mobile/app
eas init

# 4. 第一次 build dev client 推實機（iPhone）
eas build --profile development --platform ios
# 完成後會給安裝連結 / QR code，iPhone 開瀏覽器掃進去裝

# 5. 之後 Metro 連到 dev client（同 WiFi）
npx expo start --dev-client

# Build production IPA（內測用，不上架）
eas build --profile preview --platform ios

# Production + 自動上 App Store Connect
eas build --profile production --platform ios
eas submit --platform ios
```

**已知限制**：
- 需 Apple Developer Program ($99/年) 才能裝到實機（免費 Apple ID 限 simulator + 7 天 dev cert）
- Free tier EAS 每月 30 build 額度
- `production` profile 的 auto increment build number 會在 EAS server 上計算（appVersionSource: remote）

---

## 待辦評估：Expo SDK 54 → 57（2026-09-18 調查，**結論：現在不升**）

### 版本現況（已查證）

| SDK | 發布 | RN / React |
|---|---|---|
| **54（現況）** | 2025-09 | 0.81 / 19.1 |
| 55 | — | 0.83 / 19.2 |
| 56 | 2026-05-21 | 0.85 / 19.2 |
| **57** | 2026-06-30 | 0.86 / 19.2.3 |
| 58 beta | 2026-09-15 | — |

SDK 57 從 56 升上去很輕鬆（官方稱 RN 0.86「no user-facing breaking changes」）。**但工作量全在跨 55 與 56。**

### ⚠️ 先分清楚：AIRMap crash 不需要靠升 SDK 解決

`codegenConfig.ios.componentProvider` 是 **react-native-maps 1.21.0** 導入的；**1.20.1（SDK 54 的 pin）是最後一個沒有 Fabric 元件、因而必走 interop 層的版本**。peer 只要求 `react-native >= 0.76.0`，現況 0.81.5 完全符合。

也就是說：**升一個 minor（1.20.1 → 1.21.0）就能離開 interop 層**，不必動 SDK。這是成本最低的根治路徑，也是升 SDK 之前就該先試的一刀。（SDK 57 pin 的是 1.27.2，同樣有 Fabric 元件。）

### SDK 56 對本專案的實際衝擊（數字為實際掃描結果）

| 變更 | 本專案受影響範圍 |
|---|---|
| **`File.copy()` / `move()` 改 async** | **2 個呼叫點，都在關鍵路徑**：`src/db/init.ts:59` 首次啟動複製 157 MB TaiCOL bundle DB（當成同步用 → 還沒複製完就開 DB → 全新安裝冷啟動失敗）；`src/lib/backup.ts:204` `restoreSafetyBackup`（傳給 `replaceUserDb` 的 callback 型別是同步 `(dest) => void`，Promise 會被靜默丟掉 → 檔案沒寫完就跑 `initDb()`）。**tsc 不一定攔得到**（忽略回傳值是合法的） |
| **`@expo/vector-icons` → `@react-native-vector-icons/*`** | **76 個檔案**。機械式但量大 |
| **expo-router 不再相依 react-navigation** | **5 個檔案**：`app/_layout.tsx`（`ThemeProvider`/`DarkTheme`/`DefaultTheme`）、`app/(tabs)/taxonomy.tsx`（`useIsFocused`——分類樹跳轉不變式）、`app/favorites.tsx`、`KeyListView.tsx`、`SpeciesSearchPanel.tsx`（`useBottomTabBarHeight`——`check:dock` 守的那條）。官方有 codemod：`npx expo-codemod sdk-56-expo-router-react-navigation-replace` |
| **iOS 最低版本 15.1 → 16.4** | **產品決策，非技術決策**。會掉 iPhone 7/7+、6s、SE 一代、iPad mini 4、iPad Air 2。野外使用者的舊機比例要先確認 |
| `expo/fetch` 成為 `globalThis.fetch` 預設 | `src/lib/apiFetch.ts` 是全 app 唯一 HTTP 入口（HEAD probe、Retry-After、AbortController 超時）。**`check:gbif` / `check:inat` 跑純 Node，抓不到 RN runtime 差異**，只能實機驗 |
| 最低 Xcode 26.4 / Node ≥ 20.19.4 | Xcode Cloud 已在用 27，應無問題 |

**好消息**：`expo-file-system@57` **仍保留 `./legacy` 子路徑**（已查 exports），那 10 個檔案不必動。

### SDK 55 的重點

Legacy Architecture 不再支援（本專案已是 New Arch ✓）、Android edge-to-edge 變強制且 `edgeToEdgeEnabled` 從 app.json 移除（本專案用 `react-native-edge-to-edge` plugin，要確認）、最低 Xcode 26。

### SDK 57 本身：一個對本專案特別危險的點

**`expo prebuild` 現在預設清空並重新產生 `ios/` 與 `android/`**，要 `--no-clean` 才保留。而本專案 `ios/` 進版控且 `ios/Podfile` 有手加的 `post_install`（把低於 15.1 的 pod deployment target 拉上來，Xcode Cloud 才過）。Plan.md 既有註記「⚠️ 這個修改會被 prebuild 洗掉」在 57 之後風險更高——升級前應先把它做成 local config plugin（`withDangerousMod`）。

### SDK 57 實際 pin 的版本（2026-09-18 查 npm `bundledNativeModules.json`）

```
react-native                        0.86.0
react-native-maps                   1.27.2   ← 本專案已在此版
react-native-screens                4.25.2   （現況 4.16.0）
react-native-reanimated             4.5.0
react-native-gesture-handler        ~2.32.0
react-native-safe-area-context      ~5.7.0
react-native-keyboard-controller    1.21.9
react-native-webview                13.16.1
react-native-svg                    15.15.4
expo-file-system / secure-store / audio / media-library / image-picker  ~57.0.x
expo-router                         ~57.0.2
expo-asset                          ~57.0.2
```

**`react-native-maps` 的 pin 正好是 1.27.2**，也就是本日已經升到的版本 —— 這條路徑往 57 是相容的，升 SDK 時不用再動 maps。

另查 `react-native-maps@1.29.2` 的 peer 只要求 `react-native >= 0.76.0`，所以就算之後想再往前升 maps，也不必等 SDK。

### 沒被 Expo 背書的風險

**`@op-engineering/op-sqlite` 不是 Expo 模組**，不在 `bundledNativeModules`，`expo install --check` 不會驗。現況 `^15.2.12`，最新 `18.2.3`。跳到 RN 0.86 很可能連它一起要升——**那是整個資料層**。

### 為什麼現在不升

1. Drive 備份 A–C 與地圖的所有改動**一項實機驗證都還沒跑完**。在未驗證的基礎上疊跨三版的 SDK 升級，出事時分不清是誰造成的。
2. **Android 目前完全無法驗證**（缺 Google Maps API key）。一半平台盲測時不該動 RN 版本。
3. 唯一的實際痛點（原生 crash）已用 patch 擋住，且有上面那條「升一個 minor」的更便宜路徑。

### 建議順序

- [ ] 跑完 Drive A–C 與地圖的實機驗證（清單在 `Device_test.md` A、B 兩節）
- [x] 補上 Android Google Maps API key —— `app.config.ts:68` 讀 `GOOGLE_MAPS_ANDROID_API_KEY`（`.env` ＋ EAS secret）
- [ ] 把 `ios/Podfile` 的 `post_install` 做成 local config plugin（`withDangerousMod`），否則之後每次 prebuild 都會被洗掉
- [x] **單獨升 `react-native-maps`** —— 2026-09-18 直接升到 **1.27.2**（1.21.0 只發 TS 原始碼、`tsc --noEmit` 會連它一起檢查而報十多個錯），patch 與 patch-package 一併移除
- [ ] 確認 `@op-engineering/op-sqlite` 在目標 RN 版本的相容性（它是資料層，先查再動）
- [ ] 決定 iOS 最低版本是否可以抬到 16.4（產品決策）
- [ ] SDK 升級**一次一版**：54→55→56→57。56 單獨排一個 sprint，重點是上表那五項

### 已完成：react-native-maps 1.20.1 → 1.27.2（2026-09-18）

上面「單獨升 maps」那一刀做掉了，**patch 與 patch-package 一併移除**。

- **1.21.0 起新增真正的 Fabric component view**（`RNMapsMapView` / `RNMapsMarkerView` / `RNMapsGoogleMapView` / `RNMapsGooglePolygonView`），MapView 本身不再靠 legacy interop 掛載。
- **⚠️ 更正（2026-09-18）**：這裡原本寫「`AIRMap.m` 在上游已不存在／nil crash 從根消失」，**是錯的**。檔案只是改名成 `AIRMap.mm`，`AIRMap.mm:160` 那行無防護的 `insertObject:atIndex:` 還在；`RNMapsMapView` 只是包住 `AIRMap` 再轉呼叫。真正擋住舊 crash 的是 `RNMapsMapView.mm:441` 的 `if (paperView)` nil 檢查；同一方法 `:445` 的 `[fabricMarker marker]` 沒檢查，而 `prepareForRecycle` 會把它設 nil。詳見 `Update_log.md` 2026-09-17 第 6 節。**實機「編輯位置 → 取消」已於 2026-09-18 驗證通過**（不再 hang／crash）。
- **不是 1.21.0 的原因**：它 `main` 指向 `src/index.ts`（只發佈 TS 原始碼），我們的 `tsc --noEmit` 會連它一起檢查，而它在 `strict` + React 19 型別下有十多個錯誤（`skipLibCheck` 只管 `.d.ts`，無效）。1.27.2 型別已修、`tsc` 乾淨通過，且正好是 Expo SDK 57 的 pin 版本。
- peer 僅要求 `react-native >= 0.76`（現況 0.81.5）→ **脫離 Expo SDK 54 的 pin 但在相容範圍內**。`expo install --check` 會提醒版本不符，那是預期的。
- 靜態檢查全過：`tsc` / `check:cluster` / `check:i18n` / `check:dock` / `check:kav` / `check:roundtrip` / `check:gdrive` / `lint`。

**⚠️ 需要重建**：原生檔案清單變了（新增 Fabric 元件、`AIRMap.m` 改名為 `AIRMap.mm`），必須 `cd ios && pod install` 或直接 `npx expo run:ios`。

**實機待驗**（地圖整條路徑都換了原生實作，等於重驗一次）：
清單已移到 `Device_test.md` 的「B. 地圖與地理樣區 → 2026-09-18 換 react-native-maps 1.27.2 後重驗」。
