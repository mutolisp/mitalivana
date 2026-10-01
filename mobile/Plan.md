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
| `Device_test.md` | 實機驗證清單（783 項，章節與項目有編號如 43-4；通過 23、M 2；互動清單 https://claude.ai/artifact/M6suPJa1FS8ABG7gqmsu1Z ，由 `docs/device-test/build.py` 產生，2026-09-27）。**驗證項不要寫回本檔** |
| 守門 | `npm run check:*` 共 **47 支**（最新加入 `check:miren`） |
| `docs/` | 仍代表現況的參考文件：檢索表、樣區、匯出外部 API、報表、物種詳細頁、地圖、i18n、多人合併（`Team_merge.md`）、隊伍同步（`Team_sync.md`）；`docs/gloria-ui/` GLORIA 介面草稿（五語） |
| `sync-worker/` | 隊伍同步中繼伺服器（Cloudflare Worker＋R2）與自架說明（README） |
| `docs/planned/` | 規劃：AI 辨識、P2P 協作、雲端協作、Garmin 手錶快速記錄、MIREN 山區入侵植物調查、照片與檔案同步（兩份協作文件的記錄層合併已由 `docs/Team_merge.md` 實作） |
| `archive/` | 已完成或被取代的設計稿與一次性稽核 |
| `PRIVACY.md` / `PRIVACY.en.md` | 隱私政策（v0.2，2026-09-26 加入隊伍同步）；打包進 app 的「設定 → 隱私權政策」，改了要跑 `npm run privacy`（`check:privacy` 會擋） |

各領域的現行設計決策不重複寫在這裡，去對應的 `docs/` 檔看：
樣區調查 → `docs/Survey_plots_plan.md`；檢索表 → `docs/Ident_keys.md`；
地圖與圖層 → `docs/Map.md`；iNat／GBIF → `docs/External_species_api.md`；
報表 → `docs/Report.md`；物種詳細頁 → `docs/Species_details.md`；i18n → `docs/i18n.md`；
GLORIA → `~/.claude/plans/gloria-1-gloria-jazzy-lagoon.md`（`docs/gloria.md` 尚未寫，見 G3）；
GLORIA 介面草稿（五語）→ `docs/gloria-ui/`（原稿、譯文與建置腳本，流程見其 README）；
MIREN（規劃中）→ `docs/planned/MIREN.md`；
記錄的完成鎖定與復原／重做 → 本檔 I 節（程式在 `src/lib/useRecordEditing.ts`、`src/db/recordSnapshotCore.ts`）；
多人調查合併 → `docs/Team_merge.md`（本檔 L 節）；隊伍同步（雲端中繼）→ `docs/Team_sync.md`（本檔 M 節）。

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
| A1 | **檢索表 alias 索引掛錯 rank**（骨碎補 Davalliaceae 就是這個案例）：`buildIndex` 把 alias 索引在 key 自己的 `scope_rank` 底下，於是 Davalliaceae（family key）上掛的 `Davallia` 被存成 `family:Davallia`，而呼叫端查的是 `genus:Davallia` → 查不到。7 份帶 alias 的 key 有 5 份完全失效 | alias 改用 rank-agnostic 的 `ALIAS_RANK` 桶，`getKeysForScope` 回傳「exact rank 優先 ＋ alias 補上、依 id 去重」。`src/db/keys.ts:130-207`。對真的 `tw-keys` 模組（896 份 key）實跑：5 個原本查不到的單屬科現在都找得到（Dioscorea / 竹亞科 / Davallia / Woodsia / Nephrolepis），Selaginella 與 Asplenium 各多一份不同書的 family key，896 份 key 的自身 rank+name 查詢無一改變。索引與查詢邏輯抽成純模組 `src/lib/keyScopeIndex.ts`，新增 **`npm run check:keys`** 對**實際出貨的 `dist/datasets/tw-keys.db`** 斷言 7 個 alias 全部可達（把 alias 改回舊寫法會出現 9 條紅字，已實測） |
| A2 | 詳細頁「最後更新」恆為 undefined | SELECT 清單補 `updated_at`：`src/db/records.ts:275`、`src/db/collections.ts:121`。樣區走 `SELECT *` 本來就有 |
| A3 | 檢索表三個 toast 在自己的 Modal 裡看不見 | 改 `Alert`；成功那個保留「前往記錄」做為 Alert 按鈕（這張 Modal 加入後沒有任何視覺變化，拿掉等於零回饋）。`src/components/KeyMatrixRunner.tsx:225-252`，順手移除孤兒 `useToast` import |
| A4 | 重新鑑定換了學名卻還掛前一位鑑定者，且沒有鑑定日期 | **migration v40** 加 `collection_specimens.date_identified`（ISO `YYYY-MM-DD`）。`updateSpecimenTaxon` 同時寫入預設鑑定者與今日；`addSpecimen` 用採集日。型別／`SPECIMEN_COLS`／`SPECIMEN_UPDATABLE_KEYS`／`dwcMapper`（→ `dateIdentified`）／`bundleYaml` 都接上。scratch DB 實跑：既有列取得 NULL、重跑 v40 冪等 |
| A5 | 匯出大小預估在 iOS 永遠落回 3 MB 啟發值 | `mediaAssetTarget()` 從 `bundleExport.ts` 抽出共用，`exportSize.ts` 改用它；`file://` 改以 `expo-file-system` 直接量，catch 補 dev warn |
| A6 | 名錄記錄全都沒座標時地圖一片空白 | `shownSessionNoCoords` ＋ 一列提示橫幅（`app/(tabs)/map.tsx`）。訊息刻意不帶數量：i18next 的 `count` 會觸發複數，而數字本來就在記錄列表 |
| A7 | iOS 權限文案仍寫「Checklister」 | `app.config.ts` 7 條改 Mitalivana。**注意**：committed 的 `ios/…/Info.plist` 早已是 Mitalivana（手改過），所以這是**防下次 prebuild 洗回去**，不是使用者現在看得到的錯 |
| A8 | 版本號三處不一致 | 當下先對齊：`project.pbxproj` CURRENT_PROJECT_VERSION 19 → **20**（對齊 `CFBundleVersion`）、`package.json` `1.0.0` → `0.5.1`。**後續（2026-09-22）改成工具擋**：版本散在 6 個檔共 12 處，手改必漏 → `scripts/set-version.mjs` ＋ `make build_verb_num=<version>_<build>` 一次寫齊，`make check-version` / `npm run check:version` 驗證一致。build number 不得持平或倒退（App Store Connect 拒收、Play 視為降版）|
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

### B. 匯出完整性（也是出處驗證的前置）— ✅ 全部完成 2026-09-22

> **B1 完成 2026-09-22。** 三個純函式進 `src/lib/dwcMultiValue.ts`：
> `establishmentMeansDwcValue`（**控制詞彙**，7 個允許值釘在
> `scripts/vocab/establishment-means-values.json`，2026-09-22 從 GBIF vocabulary API 取得）、
> `higherClassificationOf`、`individualCountOf`。`check:dwc` 加了 30 條斷言把規則釘死。
>
> 兩件查證後推翻原判斷的事：
>
> - **`leafPhenology` 走 Extended MeasurementOrFact**（使用者指定，且是標準做法）。
>   它沒有 DwC 詞彙，而 archive 每欄都要 term URI；自鑄一個只是把問題搬個地方，
>   MeasurementOrFact 才是 DwC 給「沒有對應詞彙的觀測」的正規出口。
>   **選 eMoF 而非 `dwc:MeasurementOrFact`**：後者沒有 `occurrenceID`（對
>   `measurements_or_facts_2025-07-10.xml` 查證過，11 個 property），而 extension 列是靠
>   `coreid` 連到 core，我們的 core 是 Event —— 那會變成「這個事實屬於整場調查」，
>   說不出是哪一株植物落葉。OBIS 的 eMoF 就是為此加了 `dwc:occurrenceID`。
>   附帶好處：leaf phenology 是多值的，star schema 讓每個值各自一列，
>   不必再讓使用者去 split 一個 `|` 字串。
>   定義釘在 `scripts/vocab/gbif-extension-terms.json`（2026-09-22 取自 GBIF registry），
>   `check:dwc` 另外斷言「eMoF 必須有 occurrenceID」——這條沒了，所有測量會靜默變成事件屬性。
> - **`scientificNameID` 做不了。** `name_id` 不在 `taxonLookup.ts` 的 `TAXON_COLS` 裡，
>   資料根本沒被讀出來。原清單寫「資料也都有」對這一欄是錯的。要做得先擴 `TAXON_COLS`。
>
> **`associatedMedia` 也未做**：照片檔名是 `bundleExport.ts` 算的，`dwcRows.ts` 拿不到
> （反向 import 會成環）。要嘛把檔名 resolver 傳進去，要嘛把命名邏輯抽成純模組。獨立一刀。
>
> 守門自己抓到一個我寫錯的地方：`Number('')` 是 0，所以「沒填數量但單位是 individuals」
> 原本會輸出 `individualCount=0` —— 那是在宣告「數到零隻」，與「沒有資料」相反。已修。
>
> **B3 的三個設計點**：範圍是 manifest 自己的資料夾、路徑相對於它（同一筆記錄單獨匯出
> 與放在批次裡驗起來要一樣）；**依 path 排序**（照片是依媒體庫回傳順序附加的，不排序
> 的話同一份資料每次匯出都會得到不同 manifest，digest 就沒有意義了，簽章更不用談）；
> **manifest 不列任何 manifest**（它是完整性的根，把一個根雜湊進另一個根，會讓「誰先寫」
> 變成格式的一部分）。唯一的新依賴是 `@noble/hashes`（純 JS、無原生模組），
> 連帶重生了 app 內第三方授權清單。

> **B2 完成 2026-09-22 —— 但原本的規格是錯的。**
>
> Distribution extension 的 `dc:subject` 是 **`dwc:Taxon`**，14 個 property 裡**沒有
> `taxonID` 也沒有 `occurrenceID`**（對 `distribution.xml` 查證）。它只能靠 `coreid` 連回
> core，而主 archive 的 core 是 Event —— 一列 Distribution 會變成「這場調查事件是 EN」。
> 一份 archive 只能有一個 core，所以唯一正確的位置是**另一份以分類群為 core 的 archive**。
> 附帶好處：保育狀態只講一次，不會跟著同一種的每筆記錄重複。
>
> **一個分類群兩列 distribution**，因為那是兩個不同尺度的評估：
> `countryCode=TW` 那列帶臺灣紅皮書與「在臺灣是不是原生」；另一列不帶國家碼，帶全球 IUCN
> 與 CITES。這正是扁平 CSV 放不下兩個 `threatStatus` 的那個問題——star schema 本來就是解法。
>
> **兩個控制詞彙都查證過、都釘住了**：
> - `threatStatus` ← `scripts/vocab/threat-status-values.json`（GBIF IUCN thesaurus，
>   issued 2018-12-06）。TaiCOL 的 `NCR`/`NEN`/`NVU`/`NNT`/`NLC` 是國家層級前綴，
>   **剝掉開頭的 N**——IUCN 的區域評估用同一組類別，而「國家」這件事已經由 `countryCode`
>   講了。這也是專案既有慣例（`conservationColors.ts:5-6` 的徽章配色就是這樣對應）。
>   `LR/cd`（2001 前的舊類別，1 筆）**留空**：沒有我們能自行斷言的現代等價。
> - `appendixCITES`：GBIF 沒有發布值詞彙（2026-09-22 實查 404），所以只驗形狀——
>   只有 I / II / III 能出現。TaiCOL 的複合值 `I/II` 保留（不同族群列在不同附錄是事實），
>   但 `NC`（未列入）丟掉：「不在任何附錄」是沒有值，不是一個叫 NC 的附錄。

| # | 項目 | 落點 |
|---|---|---|
| B1 ✅ | `OCCURRENCE_COLS` 20 → **35 欄**，另加**第四個 extension** `measurementorfact.txt`（eMoF，4 欄）——archive 總欄數 44 → **63**。新增：`taxonRank` `higherClassification` `phylum` `class` `order` `genus` `taxonomicStatus` `acceptedNameUsage` `acceptedNameUsageID` `establishmentMeans` `individualCount` `recordNumber` `identifiedBy` `dateIdentified` `modified`（後者是 Dublin Core，`dwc:` 沒有這個詞彙）。三個 builder 全部填值，實際產一份 archive 逐欄驗過、meta.xml 也宣告了；eMoF 另驗多值拆列、未填不產列、occurrence 綁定正確 | `src/lib/dwcArchive.ts`、`src/lib/dwcRows.ts` |
| B2 ✅ | 保育狀態改走**第二份 Taxon-core archive**（`dwca/*_taxon_dwca.zip`）：Taxon core 15 欄 ＋ Distribution extension 7 欄。沒有任何保育狀態時回 `null`、不產這個檔 | `src/lib/dwcArchive.ts`（`buildTaxonArchive`）、`src/lib/dwcRows.ts`（`collectTaxon`）、兩個呼叫端 |
| B3 ✅ | 每個 manifest 加 `files` 陣列（`{path, bytes, sha256}`）。規則抽成純模組 `src/lib/manifestDigest.ts`，在 `finalizeZip` 注入——那是唯一所有檔案位元都存在的時點。新增 `npm run check:manifest`（16 條斷言，拿掉排序或讓 manifest 列到自己都會紅，已實測） | `src/lib/manifestDigest.ts`、`src/lib/bundleExport.ts` |

### C. 出處驗證：數位簽章 ＋ ORCID — ✅ 完成 2026-09-22

**目標**：讓拿到檔案的人能確認「這是某人實際調查的 raw data」，而且那個人確有其人。
不是防竄改的法律級簽章，是出處證明。

| # | 項目 | 落點 |
|---|---|---|
| C1 | 簽章核心（純模組） | `src/lib/signing.ts`：Ed25519 簽/驗、ORCID 檢查碼、`signed_by` 注入、`signature.json` 產生、`verifyManifest`。純的，所以守門與三支驗證端都對**同一份**程式碼斷言 |
| C2 | 金鑰管理 | `src/lib/signingKey.ts`：種子來自 SQLite `randomblob(32)`、存 `expo-secure-store` 的 `WHEN_UNLOCKED_THIS_DEVICE_ONLY`（不進備份、不跨機）。`activeSigner()` 要求「開關開 ＋ 有金鑰 ＋ 有合法 ORCID」三者齊備才回傳 |
| C3 | 匯出接上 | `finalizeZip()` 是唯一出口，所有 zip 都經過它，所以沒有「哪種匯出要簽」這種規則可以漏。順序：README 註記 → 雜湊 → 簽章（見下） |
| C4 | 設定畫面 | `app/settings/provenance.tsx`：建金鑰 → 填 ORCID/姓名 → 複製 `ed25519:…` 去 ORCID 頁面貼上 → 才打得開開關。7 語系 |
| C5 | 三支驗證端 | `mobile/verify/`：`verify.mjs`（Node 內建 crypto，零相依）、`verify.py`（`zipfile` ＋ `cryptography`，直接吃 zip）、`verify.html`（單檔 54 KB，內嵌 noble，拖 zip 進去即可） |
| C6 | 守門 | `check:sign`（46 條，每條都故意弄壞過）、`check:verifiers`（三支對同一 fixture 結論必須相同）、`check:verifyhtml`（產物沒脫節） |

**改掉的設計決策**：計畫寫「簽 canonical JSON」，實作改成**簽 `manifest.json` 的原始位元組**。
驗證端是從 zip 把那串位元組讀出來、不是重建出來，所以 canonicalization 的唯一理由
（可重現）本來就成立，而省掉它就消滅了整類跨語言分歧（key 排序、浮點格式、Unicode 跳脫）。
保證完全相同，失敗模式更少。

**三個做的時候才浮現的東西**：

- **順序是會靜默出錯的**：README 自己也被列在 manifest 的 `files` 裡，所以簽章註記必須寫在
  **算雜湊之前**；而雜湊必須在**簽章之前**。第一版把註記加在最後，每份匯出都會把自己的
  README 報成「已變更」。`check:sign` 現在用索引比對釘住這三步的順序。
- **內嵌函式庫撞名**：noble 自己宣告 63 個名字，`hexToBytes` 與 `verify.html` 的撞了 —
  module scope 撞名是 SyntaxError，**整頁空白**。改成把函式庫包進 IIFE，之後升版也不可能再撞。
  這個 bug 是 `headless.mjs`（用 Node 跑 verify.html 真正的 script）第一次執行就抓到的。
- **零 native rebuild 是可以證明的**：`check:sign` 把 `globalThis.crypto` 刪掉再簽一次。
  種子來自 SQLite、Ed25519 簽章又是決定性的（RFC 8032 §5.1.6），所以整條路徑不碰
  `getRandomValues`，不必加 `expo-crypto`。

**信任鏈到哪裡為止**（三支驗證端都會明講）：簽章有效 → 公鑰公布在某 ORCID 頁面 →
該頁面屬於本人。到「ORCID 帳號沒被盜」為止。沒有憑證機構、沒有撤銷、沒有可信時戳。

**照片被重新編碼**（LINE、雲端縮圖）報的是「**這個檔案變了**」並指名檔案，不是「簽章無效」——
後者會讓讀的人以為整份資料都可疑。

**未做（刻意）**：app 內不代寫 ORCID profile（需 member API ＋ 機構合約，還得握有能改
對方著作記錄的 token）。只顯示待貼上的那一行。

### D. 技術債 — ✅ 全部處理完 2026-09-22

| # | 項目 | 結果 |
|---|---|---|
| D1 | 34 處 `e instanceof Error ? … : String(e)` 讓 React Compiler bail out 整個元件 | 抽成 `src/lib/errText.ts`，20 檔全改。新增 **`check:compiler`** |
| D2 | `markSensuLato()` 每列一次 LIKE | 前綴 LIKE → 範圍條件 ＋ VALUES CTE 一次查齊 ＋ 一元 `+` 讓低選擇性索引失格。**實測 300 個雙名 4,923 ms → 9 ms**，結果完全相同。新增 **`check:searchplan`** 釘住查詢計畫 |
| D3 | `useMemo(() => { setState(…) })` 在 render 階段寫 state | 三處（不是兩處，`reload()` 也是）全改 `useEffect`；全專案已無此 pattern |
| D4 | Vision 移除後的三處孤兒 | `babel.config.js` plugin、`react-native-worklets-core` 相依、`ai_geomodel_filter` 全清。`react-native-worklets`（Reanimated 4 用）確認保留 |
| D5 | 死碼 | `keys.ts` 三支 `findSubkey*` ＋ 連帶孤兒 `taxonAltNames`、`clearChao2ChipCache` 全刪 |
| D6 | 兩套 rank chip | `RankChipRow` 改為委派共用的 `TaxonomyJumpChip`；**順帶修好它漏掉的 `Keyboard.dismiss()`**（memory `feedback-taxonomy-jump` 要求的那一步） |
| D7 | v13 legacy 欄位沒 drop | **migration v42** 刪掉 12 欄（容錯寫法，舊 SQLite 不會 brick），型別／白名單／roundtrip 白名單同步清 |
| D8 | migration 沒有 transaction | 每個 migration ＋ 版本戳記包在同一個 transaction。實測中途失敗會完整回滾、版本不被誤記 |
| D9 | 匯出檔名用 `start_ts ?? Date.now()` | 改 `created_at`：未開始的樣區不再每天匯出得到不同檔名 |
| D10 | `Podfile` 的 `post_install` 會被 prebuild 洗掉 | 做成 `plugins/withPodMinDeploymentTarget.js`；編輯邏輯抽成純函式並驗過冪等與模板變動時會拋錯 |
| D11 | 向量地圖 pipeline 沒有 make target | 新增 `vector-dump/tags/sprite/style/tiles/glyphs/hillshade/all/compare/upload` 十個 target，**把「step 2 依賴 step 5」那條只存在於 README 散文裡的順序寫進 `vector-all`** |
| D12 | `gps_mode` 從未寫成 `'single_point'` | 打點時寫入（軌跡進行中不降級）。這欄會進匯出 yml，原本那些名錄匯出時等於沒有模式 |
| D13 | `check:dock` 不涵蓋 KAV modal | 查證後發現真正缺的是「不准直接 import RN 原生 KAV」（會失去 wrapper 自動量測的 offset），加進 `check:kav` |
| D14 | `identification_keys.scope_name` 13 個不是 accepted Genus | 觀察項，數字未惡化，未動 |

> **查證時發現、尚未處理的缺口**：刪掉 `findSubkeyForTaxon` 一併帶走了「TaiCOL 屬移
> fallback」（查同一 taxon_id 的非接受名，拿舊屬名再找一次）。那段程式碼早就從 UI 走不到
> ——2026-09 起三個入口都改走 `getKeysForScope`——但**能力缺口是真的**：實測
> `Amauropelta` / `Coryphopteris` / `Grypothrix` / `Leptogramma` / `Neolepisorus` 在
> `tw-keys` 裡既沒有同名 key 也沒有 alias，而 `Parathelypteris`（舊屬名）下有一份。
> 最省的修法是在**資料端**補 alias（`key_sheet_import.py` 的 `_aliases_for` 已能產生），
> 不必動 app。已列進 E9。

### E. 功能缺口（依「擋住多少實際使用情境」排序）

**已完成**：E1 採集 round-trip 匯入、E2 行程 locality、E4 標本複份 ＋ 館別、E5 採集行程綁 Site
（2026-09-22）；E3 名錄端計數（2026-09-23）。詳見 `Update_log.md`。

6. **照片來源擴充到檔案 App / iCloud**（Phase 3c）—— 相簿路徑（3b）已上線。HEIC 在這條路
   沒有 picker exif，`piexif.js:480-492` 的格式閘門只收 JPEG／TIFF／裸 Exif blob，一定 throw；
   是整個 Phase 3 最難的一塊，而它擋不住大多數實際情境。
7. **分類樹**：病毒 realm 階層（`src/db/taxonomy.ts:269-284` 仍 `kingdom NOT IN (VIRUS_KINGDOMS)`）、
   批次加入（`BatchImportModal` 未掛到分類樹）。
8. **樣區**：capture GNSS → 自動建 Point site、protocol / sample size 偏好記憶、
   同樣區重複測量模型（v43 為止沒有 `visit_number` 之類欄位）。
9. **檢索表**：**TaiCOL 屬移的 key 找不到**（`Amauropelta` 等 5 屬，key 在舊屬名
   `Parathelypteris` 下；A1 已修好 alias **機制**，缺的是**資料端補 alias**）、5-5 殘項、
   5-6 全部、「目前僅維管束植物」提示、§6.4 IK 辨識重點 stages 1–5、
   進檢索表 segment 時自動比對模組更新。細節見 `docs/Ident_keys.md`。
10. **地圖**：採集記錄與樣區逐筆物種點上圖（`plot_species_records.lat/lng` 自 v13 只寫不讀，
    而使用者現在**真的會填**那兩欄了）、plots／sessions／sites 三層圖層開關、
    保育區位 GIS 面圖層（`LayerSheet` 只吃 WMTS raster，無 vector polygon overlay infra）。
11. **報表 R6**：拆分 `check-report.mjs`（約 1,840 行）、UPGMA 分群樹（建議不做，
    理由見 `docs/Report.md` §8-3）。
12. **Backend admin PDF 上傳 UI ＋ sheets sync 按鈕** —— 端點 `keys_api.py:192-249` 早就在，
    `frontend/src/routes/admin/+page.svelte` 只有 CSV 匯入。**這是 desktop 版不是 mobile**。
13. **從採集行程畫新的地理樣區** —— 現在只能綁**既有**的 site；新畫一個仍要走地圖。
    地圖的 draw 模式目前以 `?session=` 定範圍，要加採集的 scope 才能補上
    （`SiteAssignSheet` 的 `onCreateNew` 已改為選用，省略時該區塊不顯示）。
14. **跨裝置同步／協作** —— Drive 備份只是換機搬家，不是同步。
    見 `docs/planned/Online_collaboration.md` Phase 0/2/3 與 `docs/planned/P2P_collaboration.md`
    （兩者的「合併引擎」是同一件工作）。
15. **背景定位** —— `trackRecorder.ts:131` 只有前景 `watchPositionAsync`。野外電力有限，
    先評估是否真的需要。
16. **AI 物種辨識** —— 前提是使用者自訓 TaiCOL 模型。見 `docs/planned/Vision_model.md`。
17. **Garmin 手錶快速記錄物種與豐度** —— 設計與實作規劃完成、未動工（2026-09-27），
    見 `docs/planned/Garmin_watch.md`（記錄法：快速名錄／定點計數；只走藍牙；自寫 Expo 模組）。
    動工從 §九 階段 0 可行性測試開始（fēnix＋iPhone 實測中文顯示、訊息上限、收訊條件）。
18. **MIREN 山區入侵植物調查（Road＋Trail）** —— 規劃完成（2026-09-27）；階段 2、3 完成（2026-09-28：v68 schema＋純邏輯＋`check:miren`＋全部畫面與地圖測距，**未實機測試**），
    見 `docs/planned/MIREN.md`（原文在 `references/MIREN/`；artifact https://claude.ai/artifact/16GnXjrgVoaWkhrFKRSiQe ）。
    照 GLORIA 另開 sibling 模組（user.db v68）；盲記封存後當場複查、匯出加 `Found after recheck`；
    物種狀態掛 region（S2 表 B）；地圖分頁加共用測距工具確認「距其他道路 ≥100 m」。
    trail plot 配置依 Liedtke et al. 2020 釐清（2×50 m 為選做）。下一步：實機測試階段 3、§十一 階段 4（匯出）；階段 3 未做項目見 `MIREN.md` §十一；待確認：官方 trail 範本、S1／S3、臺灣 region 代碼。
19. **照片與檔案同步（隊伍同步第二版）** —— 規劃完成、未動工（2026-09-28），見 `docs/planned/Media_sync.md`
    （artifact https://claude.ai/artifact/R3NtQX5WqhEmbFAkDBhGHx ）。內容代號去重、4 MiB 分段加密、打開記錄才下載、媒體欄位併入共同基準合併。
    R2 Standard 100 GB 約 US$1.35／月（官方價目 2026-09-28 查）。已決定：預設伺服器不開放檔案同步，自架伺服器開放、總量由部署者在 app 內調（顯示預估用量與費用）。Wi-Fi 限定下載先不做。

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
- [ ] 版本目前 **0.5.2 / build 21**（七處對齊，`app.config.ts` 已宣告 `ios.buildNumber` 與 `android.versionCode`，prebuild 不會再重設）；每次上傳前遞增

> iOS App Store 流程獨立（Apple Developer Program $99/年 ＋ TestFlight ＋ App Store Connect）。
> 商店列表名稱要在各自後台改成 Mitalivana，不是 commit 能處理的。
> `ios/Checklister.xcodeproj` / `ios/Checklister/` 目錄名仍是舊名，純內部路徑、改名要重簽
> provisioning profile，**刻意不動**。

#### 已知環境問題

- [ ] Xcode 26 + macOS 25.3 的 Cryptex disk image 機制需要手動 mount runtime 才能用 simulator（已解，文件記錄）
- [ ] Expo CLI 54.0.24 與 Xcode 26 的 `devicectl` JSON format 不相容，無法 `expo run:ios --device`，需從 Xcode 開 workspace build。SDK 升 55+ 應可解
- [ ] `expo-sharing` 必須裝 14.x（SDK 54 對應版本），裝到 55.x 會 build fail（type 不相容）


### G. GLORIA 山峰監測模組（2026-09-25 上線 v47–v55，2026-09-27 補 v62–v66，細節見 `Update_log.md`）

已完成：
- 用詞：summit＝山峰、1×1 m／10×10 m 樣區、山峰區域樣區（SAS）、point-frame＝頻度點擊法、abundance＝豐度
- 資料模型、盲測重複調查（Box 4.5）、single-active 整合、Sheet 分頁 CSV＋yml＋照片匯出、歷史資料一次性轉換（57 個 zip）
- 基礎資料：山峰基本資料（名稱、WGS84 經緯度、海拔、植群帶下拉）、第幾次監測（mocy，同山峰不可重複）、環境照片（SU-OV＋拍攝位置）、28 量測點、備註（Form 1 COMMENTS）
- 樣區總覽（菱形示意圖可兩指縮放 1–4 倍＋按鈕、狀態色、p5m 標籤避開主測線且 E／W 放在 3×3 m 的另一側、SAS 標籤不被 3×3 m 蓋住；單位清單依 E／N／S／W 各一排，必做標紅 *、10×10 標選擇性調查）、物種總表（heatmap：1×1 m 優勢度／頻度互為底色可切換、SAS 豐度、10×10 m hits；物種欄固定）、
  拍照檢核 tab（必拍 54、選拍四小區 64，結束時提醒）；各輸入畫面右上的總覽面板（跳轉依 E／N／S／W）
- 1×1 m 樣區／頻度（筆刷、逐格、直接輸入次數；物種與干擾用下拉選單＋‹ ›）／頻度點擊法、SAS、10×10 逐點；
  每個輸入畫面右上都有復原／重做／總覽／完成：完成先問結束時間（更新為現在／沿用／先不記錄）再鎖定，再按解鎖、時間保留
  （優勢度估測、頻度、頻度點擊法各自一組；單位完成看 `done_locked`，手動填舊的結束時間不會鎖住）
- 物種可更換（長按或詳細頁；資料全保留、可復原、不合併重複物種）；物種詳細頁可左右滑動切換上一筆／下一筆
- 物種清單（1×1 m、SAS、10×10 m）：前面有編號（對照調查紙，與匯出 sp-N 一致）、可拖拉排序（v55 `sort_order`，
  `model/speciesOrder.ts` 供畫面與匯出共用）；輸入時列表底部讓出搜尋框高度，候選清單不會伸到標題列下
- 每單位調查者與調查時間：1×1 m、SAS、10×10 m 都在最上方「樣區環境」摺疊區內、時間可單獨收摺；
  開始／結束（日期、時間分欄，自動記錄可手改；1×1 m 有優勢度估測、頻度、頻度點擊法三組）；
  頻度接續優勢度：同一天、優勢度結束的下一分鐘開始（`model/quadratTimes.ts`）；空白的結束可一鍵「同開始時間」，舊日期的頻度編輯不會把結束改成今天
- 溫度計（Form 4，v65）：巡查掛山峰、依日期歸入週期（不綁調查）；讀取／新部署、預帶、字母、全長碼、檔案（資料檔、Form 4 掃描、位置照片）；04_ 匯出與 01_ 識別碼；山峰頁單獨匯出
- 必填檢核與紅星、坡向坡度帶入、清空樣區（v66 `no_researchers`：清空後無調查者）；10×10 m 走線照 Form 6-S 更正、示意圖、逐點物種大卡片與可縮放點位地圖
- 匯出含物種名錄（md＋依設定 docx／odt；sp1、sp2 各一行）；灌叢樣區不匯出頻度時間，頻度與點擊資料填 0 並註明「灌叢不點擊(Shrubs, not point-framed)」
- 基礎資料的開始／結束調查日期，可從各樣區帶入或帶入各樣區（只填空白、只填日期；v64 `date_only`）
- 未鑑定到種可標 sp1、sp2（v63，整次調查共用；加入時選既有或新增，詳細頁可改；Sheet 標籤放 comments）
- 1×1 m 可勾「灌叢，不做頻度與頻度點擊法」（v62 `freq_skipped`；頻度依手冊 §5.1.2，頻度點擊法一併略過是專案規則）；1×1 m、SAS、10×10 m 都有備註（`comments`）；1×1 m 加物種後焦點跳到覆蓋度
- 搜尋預設只找維管束植物（GLORIA 各搜尋框＋調查進行中的分類樹搜尋；可當下改選，不覆寫使用者的設定）
- 統計報告：單次調查與專案（目標區域、山峰、複查次數、多樣性指數、與前次比較；類型／方位／山峰篩選）；專案統計顯示 GLORIA 筆數與山峰數
- 山峰清單（偏好設定）：匯入／匯出山峰（00_ 欄位）、匯入量測點（只需點位、距離、方位）、匯出量測點（02_ 欄位），CSV 與 .xlsx
- 介面草稿 artifact（https://claude.ai/artifact/QCgtqCyBKeKFhizoRVA1Cn ，v75，五語；原稿 `docs/gloria-ui/`）：
  01 建立～09 拍照檢核，05b 頻度點擊法；完成時的結束時間選擇、物種編號與拖拉、頻度接續優勢度都已反映；app 介面改動時同步更新

待辦：
1. **DwC-A 匯出** —— 山峰為父 event、各單位為子 event，頻度與 hits 走 MoF。要先補 `OCCURRENCE_COLS.occurrenceStatus`、
   `MEASUREMENT_COLS.measurementUnit`，並跑 `check:dwc`。
2. **`gloria_taxa` 的 retaxon** —— 事後重新鑑定目前要手動；`retaxon.ts` 還不認得這張表。
3. **文件** —— `docs/gloria.md`（Sheet 分頁對照、遮罩格式與 f11…f00、手冊頁碼、照片命名與拍照檢核項目、
   山峰／量測點匯入匯出欄位）；`mitalivana-code-review` skill 加 GLORIA 檢查項。
4. **Sheet 資料** —— 稽核網頁其餘類別待使用者處理；Sheet 修正完後重跑一次性轉換再匯入（山峰與量測點
   現在也可直接用 app 內的匯入更新）。TW-SAC-JIA 的 twd97y 與其緯度差約 15 m（其餘 14 座 < 1 m），待確認哪一格打錯。
5. **匯出大小估算** —— `exportSize.ts` 對 GLORIA 只算文字，未計照片（含拍照檢核與環境照片）。
6. **外部相機的照片** —— 拍照檢核只記「已拍」，外部相機拍的檔案仍需在室內依附錄 III 命名（或用 GPDM）；
   app 只替 app 內的照片命名。之後可評估「匯入照片並依檢核項目自動命名」。
7a. **SAS 等級換算為暫定慣例** —— d→4、c→3、s→2、r→1、r!→r（2026-09-26 指定）；若日後有團隊定案或文獻依據，改 `stats.ts GLORIA_TO_BB` 並更新報告方法段。
7. **待確認** —— 截圖 4b 物種總表的 FRE 欄、Survey Type `CAL` 的意思（未確認前不做）。
8. **MIREN** —— 已取得 protocol 原文並完成規劃（2026-09-27），移到 E18，見 `docs/planned/MIREN.md`。
9. **實機驗證** —— 已通過的在 `Device_test.md` 打 x；未確認的重點：頻度手勢、下拉選單在 iOS／Android 的顯示、
   iOS 日期／時間轉輪、拍照檢核在 375 pt 寬的排版、物種拖拉（巢狀在捲動區內）、結束時間選單接在 Alert 之後是否會被吞掉。
10. **拖拉中的即時編號** —— 目前放開後才重新編號；若實測覺得需要，可用 `onPlaceholderIndexChange` 在拖曳中預覽。
11. **格式雜訊** —— `app/gloria/[id]/[code]/index.tsx` 曾被 prettier 整檔重排（2026-09-26），commit 時 diff 會偏大。
12. **其他置底搜尋的候選清單上限** —— 只有 GLORIA 單位畫面傳 `topLimit`；快速名錄、樣區物種、頻度「＋新物種」、頻度點擊法「＋搜尋」
    在頂端「調查進行中」列出現時可能仍差一列高度。若實測被蓋住，照 GLORIA 單位畫面的 `measureInWindow` 補上。

**俗名顯示語言**（同日完成）的擴充點：新增語言需要有帶該語言俗名的名錄來源；國家名錄 pack（GBIF）目前不含俗名。


### H. 儲存空間（2026-09-25 上線，細節見 `Update_log.md`）

已完成：偏好設定 →「儲存空間」頁（暫存一鍵清除、未被使用的照片與錄音確認後刪除、舊版殘留、各類大小與既有管理頁連結）；
所有分享點改為分享後 30 秒刪檔；孤兒判斷用全部媒體欄位的檔名集合（`mediaNamesIn`，`check:storage` 守門）。

待辦（都已能用「清除暫存」手動回收，這些是從源頭不再留檔）：
1. ~~**`mediaUriReferenced` 與孤兒掃描統一**~~ —— ✅ 2026-09-25：兩者共用 `src/db/media.ts referencedMediaNames()`，欄位清單只有
   `src/lib/mediaNames.ts MEDIA_COLUMNS` 一份；`check:storage` 以實際 migrate 出的 schema 比對，新增像媒體的欄位未登記即失敗。
2. **源頭漏刪** —— `backup.ts` 的 VACUUM 快照沒有 try/finally（例外時留下整份 DB）；`driveBackup.ts` 還原成功後 `drive-restore-*.zip` 不刪；
   `gbifDownload.ts` 網路例外時 `gbif-pack-*.zip` 不刪；ImagePicker 原檔在複製成功後可立即刪（`photoCapture.ts persistPickedPhoto`）。
3. **「清除所有資料」不刪照片與錄音** —— 使用者選擇維持現狀（2026-09-25）；清除後這些檔案會出現在「未被使用的照片與錄音」，可在儲存空間頁清。
4. **實機確認** —— 使用者手機 3.59 GB 的實際組成（特別是舊版 `rudymap/` 是否殘留），清除前先看頁面列出的數字。

### J. 搜尋：常用物種優先（2026-09-26，細節見 `Update_log.md`）

已完成：設定「常用物種優先」（預設開）；精確符合永遠第一，其次依記錄次數；被截斷的常用物種會補回。`check:usage-rank` 守門。

待辦：分類樹的階層搜尋（`searchTaxonomy`）未套用——它的結果 `TaxonSearchHit` 沒有 taxon_id；若要套用需先補欄位。

### K. 分類樹亞階層（2026-09-26，細節見 `Update_log.md`）

已完成：TaiCOL 親代鏈進入 tw-taicol 模組（`taxon_tree`／`rank_bridge`），v56 使用者自建中間階層與改掛，
設定可切換「目以下／全部」，階層搜尋與跳轉、批次加入、DwC 匯出五個術語。`check:intermediate` 與 `verify_datasets` 守門。

待辦：
1. **重建並上傳模組**：`make taicol-tree`（已有 2026-09-26 快照可沿用）→ `make datasets` → `make datasets-verify` → `make datasets-upload`。
   在重建前，`dist/datasets/tw-taicol.db` 沒有新表，`check:intermediate` 會失敗。
2. **實機驗證**：見 `Device_test.md` 同名段落。
3. **桌機版**尚未處理：後端 `taicol_names` 與 `taxonomy_api.py` 仍然只有六階。
4. 目前只能一次改掛一個分類群（ⓘ →「變更上層歸屬」），批次改掛只能在「新增下層分類群」的第二步做。若實測覺得不夠用，再接到多選工具列。

### L. 多人調查合併（2026-09-26，v57，細節見 `docs/Team_merge.md`）

已完成：快速名錄、樣區調查、GLORIA 匯入同一筆記錄時可選「合併」（GLORIA 以山峰＋mocy 配對，兩台可各自新建）；
審閱畫面分「需要決定」（兩邊都改、可能重複、刪除）與「自動套用」（對方新增、只有對方改）；刪除一律要點選才生效。
共同基準用內容雜湊（`sync_base`，匯出檔帶 `sync:`），不改任何寫入／刪除 helper；套用前自動備份到 `Documents/merge-backups/`。
`check:merge` 守門。

待辦：
1. **實機驗證** —— 見 `Device_test.md` 同名段落，兩支手機來回傳一次以上。
2. **採集記錄不合併** —— 採集號衝突要先有「每人採集號前綴」或重新編號的設計。
3. **已存在的列上新增的照片不帶過來**、GLORIA 照片不合併 —— 若實測需要，再定照片的身分（目前只有檔名與裝置 URI）。
4. ~~合併前備份沒有瀏覽介面~~ —— 已接到「儲存空間 → 合併前備份」，可分享、刪除（2026-09-26）。
5. **傳輸**：雲端中繼已做（M 節）；現場區網同步（`planned/P2P_collaboration.md` 階段 B）仍未做。

### M. 隊伍同步：Cloudflare Worker＋R2 中繼（2026-09-26，v58，細節見 `docs/Team_sync.md`）

已完成：
- 記錄在手機上以隊伍金鑰加密（XChaCha20-Poly1305）後，經中繼與隊友交換，再交給 L 節的合併。
- QR／邀請碼加入；「取得隊伍中的記錄」；沒網路時排隊。
- 上限：每隊伍、每台裝置、每日次數、全伺服器，可調、可個別覆寫。公用預設伺服器用嚴格值；自架（App 內，或 `npm run deploy -- --self-host`）
  用 `SELF_HOST_VARS` 大幅放寬（每隊／每台 8 GB、1,000 台、每天 100,000 次、單檔 10 MB），保留全伺服器 8 GB 與每隊 5,000 檔。
- 自架：app 內部署（先檢查帳號有無 workers.dev 子網域，沒有就停下說明，不建立任何東西），或電腦用腳本／wrangler。
- 記錄畫面標題列：點 ⋯ 原位往左展開「研究報告」與雲朵同步鈕（後者僅持有金鑰時），› 收回（`RecordMenuButton`）；名錄與 GLORIA 標題截斷時點一下顯示全名。
- 設定 → 隱私權政策：App 內離線顯示（`check:privacy` 確保與 `PRIVACY.md` 一致）。
- 隊員名稱（v59）：建立／加入時設定，名稱只在加密資料內；同步提示、審閱標頭與「隊員」清單顯示誰上傳了什麼。
- 伺服器清單與搬移（v60）：記住自己部署與輸入過的伺服器、可設新隊伍預設；隊長可把隊伍搬到其他伺服器（同一把金鑰，隊員用新邀請碼加入即切換，資料保留）。
- 隊伍頁：點隊伍進入分段的詳細頁（取代九項的動作選單），往下拉同步整個隊伍，只上傳有變更的記錄（v61）；電腦自架後以終端機 QR（`checklister://team/server`）把伺服器加進 App，不必貼網址。
- 隱私政策 v0.2（同日修訂：「加鹽雜湊」改「雜湊」、聯絡信箱改 contact@mitalivana.org，中英兩版）；app 對外請求的 User-Agent 聯絡信箱同步改為 contact@mitalivana.org。
- `check:team-crypto`、`check:team-quota`、`check:privacy` 守門。

待辦：
1. ~~部署預設伺服器~~ —— 2026-09-26 已上線：`npm run deploy` 部署 Worker `mitalivana-sync`＋私有 bucket，後台綁自訂網域 `sync.mitalivana.org`（Worker，不是 R2）；`/v1/info` 回應 api 1、上限為預設值。部署用的 API token 用完請刪除；`ADMIN_TOKEN` 由維護者自行保存。
2. **實機驗證**（Device_test 同名段落）；特別是：
   - Android 內建相機能否開啟 `checklister://team/join` 深層連結；
   - 建立隊伍時先選伺服器再輸入名稱，選單不再一閃即逝或閃退（實機回報後已修，待確認）；
   - GLORIA 標題列的開始／結束鈕不再被擠出畫面；⋯ 展開後，樣區解鎖時六顆鈕在 iPhone SE 等窄螢幕是否放得下；
   - 隊伍頁往下拉：改一筆記錄後只上傳那一筆（模擬器只驗證過「沒變更就不上傳」）；
   - 電腦自架後終端機印出的伺服器 QR 能否被手機相機掃描開啟。
3. 照片與錄音同步（第二版，先評估額度與耗電）。
4. 同步時一次只處理一位需要審閱的隊友，其餘等下一次按同步；若實測覺得太慢，再改成串接多個審閱。
5. 未查證：第一次啟用 R2 是否要先綁付款方式（影響 app 內自架的第一步說明）；Workers rate limiting binding 在免費方案能否使用（目前未使用，不影響上限正確性）。
6. 規劃與流程說明 artifact：https://claude.ai/artifact/Jie33MGbsmJkmPmvRNiysh （v7，含免費／付費方案用量試算、隊伍頁、雲朵鈕與往下拉同步）。

### I. 快速名錄／樣區調查／採集記錄的完成鎖定與復原（2026-09-25，細節見 `Update_log.md`）

已完成（2026-09-26 追加）：結束／完成一律先問結束時間（`src/lib/endTimeChoice.ts`：更新為現在／沿用／先不記錄），
重開不清時間；三種記錄與 GLORIA 都可手動填開始／結束（`src/components/SurveyTimeFields.tsx`；v54 `sessions.status`、
`gloria_units.done_locked`）。置底搜尋框的候選清單改依可用空間限高（全 app）。

已完成：結束＝鎖定（唯讀），右上鎖頭「解鎖編輯」只在當下畫面有效、不變成進行中；解鎖或進行中時右上有復原／重做；
記錄分頁刪除或合併已結束的記錄要先「解鎖並繼續」。`check:record-snapshot` 守門。

待辦：
1. **實機驗證** —— 見 `Device_test.md` 同名段落；特別是樣區小區數量改少後復原、錄音移除後復原仍能播放。
2. **鎖定時的顯示** —— 名錄與採集的詳細頁仍顯示輸入框，按下後才跳提示並還原；樣區環境頁則是整頁不接受點按＋橫幅。
   若實測覺得詳細頁應該直接顯示為唯讀，再逐欄改（`SpeciesDetailSheet`、`SpecimenDetailSheet`、`PlotSpeciesValueModal`）。
3. **不在畫面上的修改不進歷史** —— 地圖分頁移動樣區點位或編輯軌跡、分類樹或常用名錄加入物種，發生在別的畫面；
   回到記錄畫面時歷史重來，這些修改不能從記錄畫面復原。已結束的記錄本來就不會被這些入口改到。

---

### N. UI 改版「橡實野帳」（規劃見 `docs/planned/ui-redesign/`）

- [x] Phase 1：色彩 token（2026-09-28）
- [x] Phase 2：藍色與寫死 hex 收斂、`check:palette`、導覽列 header 主題、開關（2026-09-29，細節見 `Update_log.md`）
- [x] Phase 3：基礎元件 `Button`、`Chip`、`Tag`；改寫 `PillButton`、`HeaderIconButton`、`SpeciesCard`、`RecordListItem`；Source Serif 4（2026-09-29）
- [x] Phase 4：記錄首頁、建立記錄 sheet、快速名錄、物種細節（2026-09-29，細節見 `Update_log.md`）
- [x] Phase 4 追加：⋯ 下拉選單（§4b）、設定頁分組卡片與搜尋（§4c，`check:settings-index`）（2026-09-29）
- [x] Phase 4 追加：新增 GLORIA 調查與新增山峰全螢幕頁（§4d）（2026-09-29）
- [x] §4e-1 GLORIA 調查中：狀態色、header、進度列、分頁列（2026-09-29）
- [x] §4e-2 樣區分頁：p5m 列、示意圖、待處理卡片、方位切換、依方位的單位清單、3×3 m 面板（2026-09-29）
- [x] §4e-3 基礎資料分頁：p5m 分段鈕卡片、清單（原地展開原表單）、表單掃描檔集中一列（2026-09-29）
- [x] §1 釘選：圖釘鍵、兩種檢視的釘選區、左滑與多選入口、文案（2026-09-29）
- [x] 04 標本採集：ListRow／CardGrid、先給號新增（未鑑定＝Plantae）、照片格、複份至少 1（v76）（2026-09-29）
- [ ] ListRow 逐步替換其他列表（SpeciesCard、RecordListItem、GLORIA 單位列、設定列）
- [x] 05 選取標記與導覽按鈕統一、`check:controls`、`npm run check`（2026-09-29）
- [x] 06 小樣方 A 期：抽共用（grid、quadratIssues、SurfaceCover、FrequencyGrid），GLORIA 改用（2026-09-29）
- [x] 06 小樣方 B 期：v77（plot_quadrats、plot_quadrat_species、plot_surveys.quadrat_config）、DB helper（`quadratsCore.ts`／`quadrats.ts`）、record_versions／undo、刪除還原、完整性規則、媒體欄位、複製樣區、data-model 說明、`check:quadrats`（2026-09-29）
- [x] 06 小樣方 C 期：環境分頁設定區塊、小樣方分頁、單一小樣方畫面、物種色盤（2026-09-29；`plot/[id].tsx` 移到 `plot/[id]/index.tsx`）
- [x] 06 小樣方 D 期：yml 來回、合併模型與套用、團隊同步照片、記錄版本／最近刪除、手動合併樣區、小樣方照片、頻度畫面物種輸入（設計稿 10d）；兩個暫時豁免已拿掉（2026-09-29）
- [x] 記錄版本：「還原前」快照在內容與最新一版相同時被略過、之後被「離開畫面」覆寫（2026-09-29 修正：改標記那一版）
- [x] 版本／合併比對畫面：小樣方設定值與上邊、頻度方式翻譯（2026-09-29）
- [x] 06 樣區頻度（重新設計，2026-09-29）：環境「頻度（整個樣區）」開關 → 頻度分頁；v78 `plot_species_records.freq_cells/freq_count`；共用 `FrequencyPanel`；yml／合併／匯入／手動合併；設計稿 10a、10e 更新
- [x] 06 小樣方 E 期：quadrats.csv、quadrat_surface.csv、frequency.csv、DwC 子事件＋eMoF、報表「樣區頻度」與「小樣方」各節（HTML／DOCX／ODT，LibreOffice 渲染驗證）、小樣方資料品質提示（2026-09-29）
- [x] 06 頻度 UI 統一：固定樣區／小樣方／GLORIA 1×1 m 頻度共用 FrequencyPanel，筆刷用下拉物種卡、逐格與樣點用 SpeciesToggleCard；固定樣區頻度可加新物種、優勢度⇄頻度檢查（2026-09-29）
- 已決（2026-09-29）：多樣性的「樣區名錄 ∪ 小樣方物種」只用在小樣方報表小節，其他統計不變
- [ ] 列尾 `chevron-forward` 逐步換成 `Chevron`（`check:controls` 目前警告 54 處）；多行寫法的展開箭頭尚未統一 16／ink-2
- 待決：DwC `preparations` 目前只要有複份就寫 `sheet`；v76 回填後動物標本也會是 `sheet`，是否依界別決定
- 待決：記錄首頁搜尋要不要也比對物種名稱（需查 DB，新功能；規格原稿有寫，這期沒做）
- 待辦：快速名錄情境條的空間資料要顯示「起點 ±N m」得在 session 存起點精度（資料層變更，改版範圍外）
- 待辦：批次匯入的輸入框範例文字在 Android 顯示成字面的 `\n`（既有）
- [ ] Phase 5（選配）：中文標題宋體
- 待決：`bg-accent-500` 上的白字對比 4.1（原 `blue-500` 3.68，略好但低於 4.5）。名錄頁的「全部」chip 已由 Phase 3 的 `Chip` 取代（改成深色底），其餘約 20 處仍是 `bg-accent-500`
- 待辦：`key/[id].tsx` 終點的學名 className 少一個空格（`'ml-2' : ''}text-base` → `ml-2text-base`），俗名與學名黏在一起、字級也沒生效（既有 bug）
- 待辦：專案匯出「壓縮中…」的轉圈仍是藍色（Phase 2 沒清到的 `ActivityIndicator` 顏色）
- 待辦：`check:palette` 的 baseline 還有 60 檔 177 處（琥珀警示色、`#4b5563`、`#d1d5db` 等對照表外的值、模組層級常數），逐步降低；每次減少後 `npm run check:palette -- --update`

### O. 模組化調查表（規劃見 `docs/planned/Modular_survey.md`）

- [x] 規劃：元件盤點、模板 schema、通用表、路線圖；設計畫板 11–13（2026-10-01）
- [x] 對照程式碼審查；修正審查發現的三個既有 bug（小數逗號、形態種矩陣、eventID 不一致）（2026-10-01，見 `Update_log.md`）
- 已決（2026-10-01）：以 20 m 樣方為版本／復原／合併單位、1 ha 區塊為同步單位；每木回合不受 single-active 限制；樹號依區塊號段；預設一套健康代碼；Android 平板開放橫向；值表依擁有者分開並有外鍵
- [x] Phase 0：每木純邏輯與 `check:stemmap`；記錄種類分派改窮舉；抽出共用元件（2026-10-01，見 `Update_log.md`）。`EnvTab`／`LayerSection`／`SubplotSection` 改寫與兩份數字欄合併留到 Phase 2
- [ ] Phase 1：框架核心（v80）＋每木調查模板（`docs/ForestGEO/Stem_mapping.md`），含團隊合併、平板分割畫面、vegan 寬表
  - [x] 1A 資料層：v80 各表、模板型別／registry／驗證器（`check:templates`）、內建每木模板、每木資料層 `src/survey/db/stemmapCore.ts`（`check:survey-db`）（2026-10-01）
  - [x] 1B 畫面：設定開關（預設關閉）、永久樣區、回合畫面、位置圖、單株編輯、複查、檢查清單、平板分割與 Android 平板橫向、7 種語系（2026-10-01；實機見 Device_test §77；Android 橫向要重新 build 原生）
  - [x] 1C-a 以樣方為單位的版本、復原／重做、救回刪除的回合（2026-10-01；只在本機；實機見 Device_test §78）
  - [x] 1C-b 以區塊為單位的隊伍同步與合併、區塊認領、手上樹牌起始號、合併檢視虛擬化、每木照片同步（2026-10-01；v82；實機見 Device_test §79）
  - [x] 1D yml／csv／vegan 寬表匯出、匯入（合併／覆蓋／略過）、roundtrip（2026-10-01；實機見 Device_test §80；DwC-A 維持 Phase 2）
  - [x] 1E 2 萬株壓力測試：開發版測試畫面與 `check:census-stress`；修正逐株查詢掃全回合、切片 OR 掃全區、匯出檔改 JSON（仍為 .yml）、查名索引被綁架（全 app）、樹號排序、完整備份／回復讀位元組（5 萬株原本記憶體不足）；每分支位元組 320 B（2026-10-02；模擬器數字見 `Update_log.md`；實機見 Device_test §81）
- [ ] Phase 2：建表器、模板分享、checklist／plot 樣式、其餘元件、DwC-A（organismID、eMoF）
- [ ] Phase 3：既有記錄類型逐步遷移
- 已決（2026-10-01）：永久樣區也給樣區型調查複查用（eventID 沿用 `plotEventIds` 規則、單位配置與形態種清單存在樣區上、物種預設盲測）；死亡個體用 `dwc:vitality`（TDWG 與 GBIF 定義已核對）；同步區塊依樣區大小與密度每回合決定，樹號區塊固定且與同步區塊分開
- 已決（2026-10-01）：樣區型複查比照 MIREN 先盲測、結束後顯示前次清單（第一次調查不分階段）；同步區塊大小先採 §7.9，Phase 1 實測後修正
- [x] Phase 1 實測每分支位元組（248 B，常數 320，2026-10-02）；密度預設值 6000 分支／ha 維持，等真實樣區資料再修
- 待辦（1E 量到、不擋 2 萬株）：
  - 匯出 zip 44 s（模擬器、2 萬株）：主要是 JS 的 SHA-256（約 1 s／MB）與 deflate。換原生雜湊要加原生模組（`expo-crypto`），等下次重 build 原生時評估
  - 匯入讀檔 9 s 中 7 s 是 `TextDecoder`（13 MB）；檔案若全為 ASCII 可走 latin1 快路徑（要把非 ASCII 寫成 `\uXXXX`）
  - 刪除大回合（25 s）、匯入建立（12 s）、完整備份（33 s）期間 JS 執行緒整段被占住，畫面不更新也沒有進度
  - 回合畫面每次回到前景都重算全回合狀態（`censusTreeStates`，0.8 s）；可改為只更新剛存檔的樣方
  - 檢查清單 1.9 s（讀整個回合）
  - 刪除大回合後 `user.db` 檔案不會變小（SQLite 只標空頁；5 萬株刪除後仍 125 MB）。要不要在儲存空間頁提供壓縮（VACUUM），待決
  - 實機（Device_test §81）的數字回來後，再決定以上哪些要在 Phase 2 前做

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
