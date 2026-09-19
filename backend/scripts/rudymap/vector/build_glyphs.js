#!/usr/bin/env node
// 產生 MapLibre 要的 glyph PBF。
//
// **中日韓不用產。** MapLibre Native 兩個平台預設就用裝置自己的字型做本地算繪：
//   iOS     MLNRendererConfiguration.m 沒讀到 Info.plist 的 MLNIdeographicFontFamilyName
//           時 fallback 到 [UIFont systemFontOfSize:0 weight:Regular].familyName
//   Android MapLibreMapOptions 的 localIdeographFontFamilyEnabled 預設 true，
//           沒給 XML 屬性時用 MapLibreConstants.DEFAULT_FONT = "sans-serif"
// 所以自架 30-60 MB 的 CJK glyph 是白做工，離線包也不必塞。
//
// 真正要自架的只有拉丁字母、數字與標點 —— 路線編號（台21甲的「21」）、等高線
// 高程（3952）、山屋標高都靠它。
//
// **缺一個 range 會讓整張圖算不出來**，不是只有標籤消失（實測：拿掉 CJK 標點
// 那幾段之後，玉山那張只剩下緣一條帶子有內容，console 只報 glyph 404、沒有任何
// 算繪錯誤）。所以 range 清單要由 glyph_ranges.py 從實際資料反推，不要用猜的；
// 字型覆蓋不到的 range 照樣會產出合法的空 PBF，那正是防止整張圖掛掉的保險。
//
// 用法：
//   node build_glyphs.js <font.ttf> <輸出目錄> [--ranges ranges.json] [--stack 名稱]
//
// 輸出 <輸出目錄>/<fontstack>/<start>-<end>.pbf，對應 style 的
// glyphs: ".../{fontstack}/{range}.pbf"。

const fs = require('fs');
const path = require('path');
const fontnik = require('fontnik');

// MapLibre 一次要 256 個字碼。這幾段涵蓋這份主題會用到的非 CJK 字元：
//   0-255      ASCII + Latin-1（數字、路線編號、英文名）
//   256-511    Latin Extended-A
//   8192-8447  一般標點與貨幣（‧ – — ′ ″ 之類）
//   8448-8703  類字母符號與數字形式（№ ½ ¼）
const DEFAULT_RANGES = [[0, 255], [256, 511], [8192, 8447], [8448, 8703]];

function rangeAsync(font, start, end) {
  return new Promise((resolve, reject) => {
    fontnik.range({ font, start, end }, (err, pbf) => (err ? reject(err) : resolve(pbf)));
  });
}

function parseArgs(argv) {
  const out = { positional: [], ranges: null, stack: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ranges') out.ranges = argv[++i];
    else if (argv[i] === '--stack') out.stack = argv[++i];
    else out.positional.push(argv[i]);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [ttf, outDir] = args.positional;
  if (!ttf || !outDir) {
    console.error('用法: build_glyphs.js <font.ttf> <輸出目錄> [--ranges ranges.json] [--stack 名稱]');
    process.exit(2);
  }

  const font = fs.readFileSync(ttf);
  const faces = await new Promise((res, rej) =>
    fontnik.load(font, (e, f) => (e ? rej(e) : res(f))));
  // fontstack 名稱必須與 style 裡的 text-font 完全一致。
  const stack = args.stack || `${faces[0].family_name} ${faces[0].style_name}`;
  const dir = path.join(outDir, stack);
  fs.mkdirSync(dir, { recursive: true });

  const ranges = args.ranges
    ? JSON.parse(fs.readFileSync(args.ranges, 'utf8'))
    : DEFAULT_RANGES;

  let total = 0;
  for (const [start, end] of ranges) {
    const pbf = await rangeAsync(font, start, end);
    const file = path.join(dir, `${start}-${end}.pbf`);
    fs.writeFileSync(file, pbf);
    total += pbf.length;
    // 很小代表字型沒有涵蓋這一段；仍然要寫出去，不然 MapLibre 會 404。
    const note = pbf.length < 256 ? '（字型無此區段，空 PBF）' : '';
    console.log(`  ${stack}/${start}-${end}.pbf  ${(pbf.length / 1024).toFixed(1)} KB ${note}`);
  }
  console.log(`完成：fontstack "${stack}"，${ranges.length} 段，共 ${(total / 1024).toFixed(0)} KB`);
  console.log(`  → ${dir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
