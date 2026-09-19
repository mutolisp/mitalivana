/**
 * 把 R2 上的 PMTiles 轉譯成一般的 XYZ 圖磚 URL。
 *
 * 為什麼需要這一層：向量有 370,899 張圖磚、陰影有 2,952 張，逐張上傳到 R2
 * 不可行（也會產生 37 萬次 Class A 操作），所以整個金字塔收成單一 PMTiles 檔。
 * 但 **MapLibre Native 不認 pmtiles:// 協定**（那是 maplibre-gl-js 的 plugin
 * 才有的東西），手機端只吃一般的圖磚 URL，所以要有人做翻譯。
 *
 * 路由：
 *   /vector/<版本>/tiles/{z}/{x}/{y}.pbf       → rudy-z0-14 或 rudy-z15.pmtiles
 *   /vector/<版本>/hillshade/{z}/{x}/{y}.png   → hillshade.pmtiles
 *   其餘（style.json / sprite / glyph）        → 直接回 R2 物件
 *
 * 本來想只把圖磚路徑導進 Worker，但 Cloudflare 的路由樣式只允許萬用字元出現在
 * 主機名開頭與路徑結尾，寫不出 `/vector/*\/tiles/*`。整個 /vector/ 都進來反而
 * 更整齊：CORS 與快取標頭有單一出口。
 *
 * PMTiles 的讀取靠三段 range request：header（前 127 bytes）→ 目錄 →
 * 圖磚本體。header 與根目錄用 Cache API 快取住，實際每張圖磚通常只要一次
 * R2 讀取。
 */

interface Env {
  BUCKET: R2Bucket;
}

/** PMTiles v3 的 header 固定 127 bytes。 */
const HEADER_BYTES = 127;

/** 供應出去的圖磚可以無限期快取：版本目錄一旦寫入就不再改。 */
const TILE_CACHE = 'public, max-age=31536000, immutable';

/**
 * Worker 自己那層 Cache API 的版本。
 *
 * 圖磚 URL 不會變（版本在路徑裡），所以改了回應的編碼方式之後，舊的快取項
 * 會一直被送出去。踩過一次：把 gzip 直傳改成解壓後回傳，線上卻還是舊的。
 * 改動回應格式時把這個數字加一即可。
 */
const CACHE_VERSION = 2;

type Header = {
  rootDirOffset: number;
  rootDirLength: number;
  leafDirOffset: number;
  tileDataOffset: number;
  internalCompression: number;
  tileCompression: number;
  minZoom: number;
  maxZoom: number;
};

type Entry = {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
};

/** Hilbert 曲線上的位置。PMTiles 用它把 (z,x,y) 攤成一維的 tileId。 */
function zxyToTileId(z: number, x: number, y: number): number {
  if (z > 26) throw new Error('zoom 超出範圍');
  // 前面所有 zoom 的圖磚數量總和：(4^z - 1) / 3
  let acc = 0;
  for (let t = 0; t < z; t++) acc += (1 << t) * (1 << t);

  let n = 1 << z;
  let rx = 0;
  let ry = 0;
  let d = 0;
  let px = x;
  let py = y;
  for (let s = n >> 1; s > 0; s >>= 1) {
    rx = (px & s) > 0 ? 1 : 0;
    ry = (py & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    // rotate
    if (ry === 0) {
      if (rx === 1) {
        px = s - 1 - px;
        py = s - 1 - py;
      }
      const tmp = px;
      px = py;
      py = tmp;
    }
  }
  return acc + d;
}

function readVarint(buf: Uint8Array, pos: { i: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[pos.i++]!;
    result += (b & 0x7f) * Math.pow(2, shift);
    if (b < 0x80) return result;
    shift += 7;
  }
}

async function maybeDecompress(data: Uint8Array, compression: number): Promise<Uint8Array> {
  // 1 = none, 2 = gzip；PMTiles 也允許 brotli/zstd，我們的檔案不會用到。
  if (compression !== 2) return data;
  // 直接把 bytes 包成 Response 再取 body，省掉 Blob（workers-types v5 沒有
  // BlobPart，而且這樣少一次複製）。
  const src = new Response(data).body;
  if (!src) return data;
  const out = src.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function parseHeader(buf: Uint8Array): Header {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint16(0, true) !== 0x4d50) throw new Error('不是 PMTiles 檔');
  return {
    rootDirOffset: Number(dv.getBigUint64(8, true)),
    rootDirLength: Number(dv.getBigUint64(16, true)),
    // PMTiles v3 的 header：40 是葉目錄位移、56 才是圖磚資料位移。
    // 原本兩個都讀 40，陰影那份剛好沒有葉目錄（兩值相同）所以看不出來，
    // 向量有葉目錄就整個讀到錯的位置。
    leafDirOffset: Number(dv.getBigUint64(40, true)),
    tileDataOffset: Number(dv.getBigUint64(56, true)),
    internalCompression: dv.getUint8(97),
    tileCompression: dv.getUint8(98),
    minZoom: dv.getUint8(100),
    maxZoom: dv.getUint8(101),
  };
}

function parseDirectory(buf: Uint8Array): Entry[] {
  const pos = { i: 0 };
  const count = readVarint(buf, pos);
  const entries: Entry[] = new Array(count);

  let lastId = 0;
  for (let i = 0; i < count; i++) {
    const delta = readVarint(buf, pos);
    lastId += delta;
    entries[i] = { tileId: lastId, offset: 0, length: 0, runLength: 0 };
  }
  for (let i = 0; i < count; i++) entries[i]!.runLength = readVarint(buf, pos);
  for (let i = 0; i < count; i++) entries[i]!.length = readVarint(buf, pos);
  for (let i = 0; i < count; i++) {
    const v = readVarint(buf, pos);
    // 0 代表「接在前一筆後面」，這是 PMTiles 省空間的編碼方式
    entries[i]!.offset = v === 0 && i > 0
      ? entries[i - 1]!.offset + entries[i - 1]!.length
      : v - 1;
  }
  return entries;
}

function findEntry(entries: Entry[], tileId: number): Entry | null {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid]!;
    if (tileId < e.tileId) hi = mid - 1;
    else if (tileId > e.tileId) lo = mid + 1;
    else return e;
  }
  // 落在某筆的 run 範圍內也算命中
  if (hi >= 0) {
    const e = entries[hi]!;
    if (e.runLength > 0 && tileId - e.tileId < e.runLength) return e;
    if (e.runLength === 0) return e; // 指向下一層目錄
  }
  return null;
}

async function readRange(
  bucket: R2Bucket,
  key: string,
  offset: number,
  length: number,
): Promise<Uint8Array | null> {
  const obj = await bucket.get(key, { range: { offset, length } });
  if (!obj) return null;
  return new Uint8Array(await obj.arrayBuffer());
}

async function getTile(
  bucket: R2Bucket,
  key: string,
  z: number,
  x: number,
  y: number,
): Promise<{ data: Uint8Array; compression: number } | null> {
  const headBuf = await readRange(bucket, key, 0, HEADER_BYTES);
  if (!headBuf) return null;
  const header = parseHeader(headBuf);
  if (z < header.minZoom || z > header.maxZoom) return null;

  const tileId = zxyToTileId(z, x, y);

  let dirOffset = header.rootDirOffset;
  let dirLength = header.rootDirLength;
  // 最多三層目錄（PMTiles 規格保證不會更深）
  for (let depth = 0; depth < 4; depth++) {
    const raw = await readRange(bucket, key, dirOffset, dirLength);
    if (!raw) return null;
    const entries = parseDirectory(await maybeDecompress(raw, header.internalCompression));
    const entry = findEntry(entries, tileId);
    if (!entry || entry.length === 0) return null;

    if (entry.runLength === 0) {
      // 指向葉目錄，再往下一層
      dirOffset = header.leafDirOffset + entry.offset;
      dirLength = entry.length;
      continue;
    }
    const data = await readRange(
      bucket, key, header.tileDataOffset + entry.offset, entry.length,
    );
    if (!data) return null;
    return { data, compression: header.tileCompression };
  }
  return null;
}


/**
 * 產生一個「有 fontstack、沒有字」的 glyph PBF。
 *
 * 為什麼需要：**少一個 glyph range，MapLibre 會整張圖算不出來**，不是只有
 * 那幾個字消失。而該要哪些 range 很難事先窮舉 —— 實機第一次開圖就撞到
 * 56832-57087（UTF-16 代理區，因為地名裡有 `石𥕢山` 這種超出 BMP 的罕用字），
 * 那是瀏覽器端不會請求、桌面驗證抓不到的。
 *
 * 所以缺的 range 一律回這個空殼：字會是空白，但地圖照常畫。
 *
 * proto:  glyphs { repeated fontstack stacks = 1 }
 *         fontstack { required string name = 1; required string range = 2 }
 */
function emptyGlyphPbf(fontstack: string, range: string): Uint8Array {
  const enc = new TextEncoder();
  const field = (num: number, payload: Uint8Array): number[] => [
    (num << 3) | 2, payload.length, ...payload,
  ];
  const stack = [
    ...field(1, enc.encode(fontstack)),
    ...field(2, enc.encode(range)),
  ];
  return new Uint8Array(field(1, new Uint8Array(stack)));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // /vector/<version>/(tiles|hillshade)/{z}/{x}/{y}.(pbf|png)
    const m = url.pathname.match(
      /^\/vector\/([^/]+)\/(tiles|hillshade)\/(\d+)\/(\d+)\/(\d+)\.(pbf|png)$/,
    );
    if (!m) {
      // 不是圖磚路徑 → 當成一般物件（style.json、sprite、glyph、.pmtiles）直接回。
      // 一定要解碼：fontstack 名稱含空格（"Noto Sans Regular"），pathname 裡是
      // %20，但 R2 的 key 是實際的空格，不解碼就一路 404。
      const key = decodeURIComponent(url.pathname).replace(/^\//, '');

      // **Range 一定要轉給 R2。** MapLibre Native 的 pmtiles:// 是靠範圍請求
      // 逐段讀 .pmtiles 的；這段忽略 Range 的話每取一張圖磚都會拉回整個
      // 383 MB 檔案，等於完全不能用（踩過，回的是 200 + 全檔）。
      const rangeHeader = request.headers.get('range');
      const obj = await env.BUCKET.get(key, rangeHeader ? { range: request.headers } : undefined);
      if (!obj) {
        // glyph 缺件不能回 404 —— MapLibre 會整張圖不畫。回空殼讓它繼續。
        const glyph = key.match(/\/fonts\/([^/]+)\/([0-9]+-[0-9]+)\.pbf$/);
        if (glyph) {
          return new Response(emptyGlyphPbf(glyph[1]!, glyph[2]!) as unknown as BodyInit, {
            headers: {
              'Content-Type': 'application/x-protobuf',
              'Cache-Control': TILE_CACHE,
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
        return new Response('not found', { status: 404 });
      }

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Accept-Ranges', 'bytes');
      if (!headers.has('Cache-Control')) headers.set('Cache-Control', TILE_CACHE);

      const range = obj.range;
      if (rangeHeader && range && 'offset' in range && 'length' in range) {
        const start = range.offset ?? 0;
        const end = start + (range.length ?? 0) - 1;
        headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
        headers.set('Content-Length', String(range.length ?? 0));
        return new Response(obj.body, { status: 206, headers });
      }
      headers.set('Content-Length', String(obj.size));
      return new Response(obj.body, { headers });
    }

    const [, version, kind, zs, xs, ys] = m;
    const z = Number(zs);
    const x = Number(xs);
    const y = Number(ys);

    const cache = caches.default;
    // 快取鍵帶上版本，改了回應格式就不會讀到舊的。
    const cacheKey = new Request(`${url.origin}${url.pathname}?cv=${CACHE_VERSION}`, request);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    // 向量切成兩份是因為 wrangler 單檔上限 300 MiB（整份 383 MB）。
    // 切點在 z14/z15 之間，所以依請求的 zoom 選檔。
    const name =
      kind === 'hillshade' ? 'hillshade' : z >= 15 ? 'rudy-z15' : 'rudy-z0-14';
    const key = `vector/${version}/${name}.pmtiles`;
    let found: { data: Uint8Array; compression: number } | null;
    try {
      found = await getTile(env.BUCKET, key, z, x, y);
    } catch (e) {
      return new Response(`pmtiles 讀取失敗：${(e as Error).message}`, { status: 500 });
    }
    if (!found) {
      // 沒有這張磚是正常的（海域、範圍外）。204 讓 MapLibre 當成空磚而不是錯誤。
      return new Response(null, { status: 204, headers: { 'Cache-Control': TILE_CACHE } });
    }

    const headers = new Headers({
      'Content-Type': kind === 'tiles' ? 'application/x-protobuf' : 'image/png',
      'Cache-Control': TILE_CACHE,
      'Access-Control-Allow-Origin': '*',
    });

    // 向量圖磚在 PMTiles 裡是 gzip 存放。**一定要在這裡解開**，不能只加
    // Content-Encoding 讓它原樣過去：Cloudflare 對 Worker 自己設的
    // Content-Encoding 處理不一致 —— 用戶端沒送 Accept-Encoding 時它會把標頭
    // 拿掉卻不解壓（客戶端拿到 gzip 卻以為是 protobuf），送了則可能再壓一層。
    // 兩種情形 MapLibre 都會報「Unable to parse the tile」。
    // 解開後由 Cloudflare 自行決定線路壓縮，行為才單純。
    const body = await maybeDecompress(found.data, found.compression);

    const res = new Response(body as unknown as BodyInit, { headers });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
