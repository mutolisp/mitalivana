/**
 * Phase-0 device diagnostics (throwaway). Each block answers one open question
 * from the plan with a measured value and a pass/fail against its threshold;
 * results are meant to be copied into the PR.
 *
 * Nothing here writes fake survey data into user.db: the snapshot benchmark
 * uses its own scratch database and IndexedDB key, the photo test its own
 * media keys. The only user.db write is the force-quit counter (settings key
 * `web_diag_counter`).
 */
import { useEffect, useRef, useState } from 'react';
import { zipSync } from 'fflate';
import { getUserDb } from '../host/dbInit';
import { idbDelete, idbGet, idbKeys, idbPut, storageStatus, writeSnapshot, type Flusher, type StorageStatus } from '../host/persist';
import { openMemoryDb } from '../host/sqlite';
import { downloadSpecies, fetchSpeciesManifest, installedSpecies } from '../host/speciesInstall';
import { searchWithFuzzyFallback } from '~/db/fuzzy';
import { GLORIA_SEARCH_GROUPS } from '~/modules/gloria/useSurvey';
import { readExifSummary } from './exif';

export type BootTimings = { bootMs: number; speciesMountMs: number };

const ms = (n: number) => `${n.toFixed(0)} ms`;
const mb = (n: number | null | undefined) => (n == null ? '—' : `${(n / 1e6).toFixed(1)} MB`);

function Verdict({ ok }: { ok: boolean | null }) {
  if (ok === null) return null;
  return <span className={ok ? 'ml-2 font-semibold text-green-700' : 'ml-2 font-semibold text-red-700'}>{ok ? 'PASS' : 'FAIL'}</span>;
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 rounded-lg border border-stone-300 p-3">
      <h2 className="font-semibold">{title}</h2>
      <div className="mt-2 space-y-1 text-sm">{children}</div>
    </section>
  );
}

const Btn = (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button {...p} className="mr-2 mt-1 rounded bg-stone-800 px-3 py-1.5 text-white disabled:opacity-40" />
);

async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function Diagnostics({ flusher, timings, speciesVersion }: { flusher: Flusher; timings: BootTimings; speciesVersion: string | null }) {
  const [log, setLog] = useState<string[]>([]);
  const add = (s: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()}  ${s}`]);

  return (
    <main className="mx-auto max-w-2xl p-4 font-sans">
      <a href="#/" className="text-blue-700 underline">
        ← 返回
      </a>
      <h1 className="mt-2 text-xl font-semibold">實機診斷（Phase 0）</h1>
      <EnvBlock />
      <Block title="1. 啟動與名錄">
        <div>
          開啟 user.db＋migrations：{ms(timings.bootMs)}
          <Verdict ok={timings.bootMs < 1500} />
        </div>
        <div>
          名錄還原（反序列化）：{speciesVersion ? ms(timings.speciesMountMs) : '尚未下載'}
          {speciesVersion ? <Verdict ok={timings.speciesMountMs < 1000} /> : null}
        </div>
        <SpeciesBlock add={add} />
      </Block>
      <SnapshotBlock flusher={flusher} add={add} />
      <PhotoBlock add={add} />
      <ExportBlock add={add} />
      <GbifBlock add={add} />
      <GeoBlock add={add} />
      <Block title="紀錄（複製到 PR）">
        <pre className="whitespace-pre-wrap text-xs">{log.join('\n') || '—'}</pre>
        <Btn onClick={() => void navigator.clipboard?.writeText(log.join('\n'))}>複製</Btn>
      </Block>
    </main>
  );
}

function EnvBlock() {
  const [st, setSt] = useState<StorageStatus | null>(null);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  useEffect(() => {
    void storageStatus().then(setSt);
  }, []);
  return (
    <Block title="0. 環境">
      <div className="break-all text-xs">{navigator.userAgent}</div>
      <div>主畫面 app（standalone）：{standalone ? '是' : '否'}</div>
      <div>Service worker 控制中：{navigator.serviceWorker?.controller ? '是' : '否'}</div>
      <div>連線：{navigator.onLine ? '線上' : '離線'}</div>
      <div>
        持久化（persist）：{st?.persisted == null ? '—' : st.persisted ? '是' : '否'}
        <Verdict ok={st?.persisted ?? null} />
      </div>
      <div>
        用量／配額：{mb(st?.usage)} / {mb(st?.quota)}
        <Verdict ok={st?.quota == null ? null : st.quota >= 1e9} />
      </div>
      <Btn
        onClick={async () => {
          await navigator.storage?.persist?.();
          setSt(await storageStatus());
        }}
      >
        要求持久化
      </Btn>
    </Block>
  );
}

function SpeciesBlock({ add }: { add: (s: string) => void }) {
  const [progress, setProgress] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [bench, setBench] = useState<{ p50: number; p95: number } | null>(null);

  const download = async () => {
    setBusy(true);
    try {
      const m = await fetchSpeciesManifest();
      const t0 = performance.now();
      await downloadSpecies(m, (d, t) => setProgress(`${mb(d)} / ${mb(t)}`));
      add(`名錄下載＋安裝 ${m.version}: ${ms(performance.now() - t0)}`);
      setProgress(`已安裝 ${m.version}`);
    } catch (e) {
      add(`名錄下載失敗: ${String(e)}`);
      setProgress(String(e));
    } finally {
      setBusy(false);
    }
  };

  const benchmark = async () => {
    if (!(await installedSpecies())) {
      add('搜尋測試：尚未下載名錄');
      return;
    }
    const qs = ['玉山', '圓柏', '冷杉', 'Abies', 'Juniperus', '杜鵑', '臺灣', '台灣', '龍膽', 'Gentiana', '薹', '箭竹', '虎耳草', '玉山園柏', '臺灣冷衫', 'Rhodo', '毛茛', '佛甲草', 'Sedum', '小檗'];
    // First call warms the fuzzy index; measured separately.
    const w0 = performance.now();
    searchWithFuzzyFallback({ q: '玉山', groups: GLORIA_SEARCH_GROUPS });
    const warm = performance.now() - w0;
    const times: number[] = [];
    for (const q of qs) {
      const t0 = performance.now();
      searchWithFuzzyFallback({ q, groups: GLORIA_SEARCH_GROUPS });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const r = { p50: times[Math.floor(times.length * 0.5)], p95: times[Math.floor(times.length * 0.95)] };
    setBench(r);
    add(`搜尋 ${qs.length} 次：首次 ${ms(warm)}，p50 ${ms(r.p50)}，p95 ${ms(r.p95)}`);
  };

  return (
    <>
      <div>
        <Btn disabled={busy} onClick={() => void download()}>
          下載／更新名錄
        </Btn>
        <span className="text-xs">{progress}</span>
      </div>
      <div>
        <Btn onClick={() => void benchmark()}>搜尋效能</Btn>
        {bench ? (
          <span>
            p50 {ms(bench.p50)}，p95 {ms(bench.p95)}
            <Verdict ok={bench.p95 < 100} />
          </span>
        ) : null}
      </div>
    </>
  );
}

function SnapshotBlock({ flusher, add }: { flusher: Flusher; add: (s: string) => void }) {
  const [counter, setCounter] = useState<number>(() => {
    const r = getUserDb().executeSync(`SELECT value FROM settings WHERE key = 'web_diag_counter'`).rows[0];
    return Number((r as { value?: string } | undefined)?.value ?? 0);
  });
  const [state, setState] = useState(flusher.state());
  useEffect(() => flusher.subscribe(setState), [flusher]);

  const bump = () => {
    const next = counter + 1;
    getUserDb().executeSync(`INSERT OR REPLACE INTO settings (key, value) VALUES ('web_diag_counter', ?)`, [String(next)]);
    setCounter(next);
  };

  const bench = async () => {
    // A 5 MB scratch database, written to its own key and removed afterwards.
    const db = await openMemoryDb();
    db.executeSync('CREATE TABLE t (x TEXT)');
    const chunk = 'x'.repeat(1000);
    db.executeSync('BEGIN');
    for (let i = 0; i < 5000; i++) db.executeSync('INSERT INTO t VALUES (?)', [chunk + i]);
    db.executeSync('COMMIT');
    const t0 = performance.now();
    const bytes = db.exportBytes();
    const t1 = performance.now();
    await writeSnapshot('diag.db', { bytes, schemaVersion: 0, savedAt: Date.now() });
    const t2 = performance.now();
    db.close();
    await idbDelete('db', 'diag.db');
    await idbDelete('db', 'diag.db.prev');
    add(`快照 ${mb(bytes.byteLength)}：匯出 ${ms(t1 - t0)}＋寫入 ${ms(t2 - t1)} = ${ms(t2 - t0)}`);
  };

  return (
    <Block title="2. 快照存檔">
      <div>
        存檔狀態：{state}
      </div>
      <Btn onClick={() => void bench()}>5 MB 快照效能（門檻 150 ms）</Btn>
      <div className="mt-2">
        強制關閉測試：按「+1」後約 1 秒內從 app 切換器滑掉 app，再打開，數字應與按下時相同（最多少 1）。
      </div>
      <div className="text-3xl font-bold">{counter}</div>
      <Btn onClick={bump}>+1</Btn>
    </Block>
  );
}

type StoredPhoto = { name: string; type: string; size: number; sha: string; blob: Blob };

function PhotoBlock({ add }: { add: (s: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [count, setCount] = useState<number | null>(null);

  const refresh = async () => setCount((await idbKeys('media')).filter((k) => k.startsWith('diag/')).length);
  useEffect(() => {
    void refresh();
  }, []);

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const buf = new Uint8Array(await f.arrayBuffer());
      const sha = await sha256(buf);
      const exif = readExifSummary(buf);
      await idbPut('media', `diag/${Date.now()}-${f.name}`, { name: f.name, type: f.type, size: f.size, sha, blob: f } satisfies StoredPhoto);
      add(`照片 ${f.name}: ${f.type || '(無類型)'} ${mb(f.size)}；EXIF ${exif.hasExif ? '有' : '無'}，拍攝時間 ${exif.dateTimeOriginal ?? '無'}，GPS ${exif.hasGps ? '有' : '無'}`);
    }
    await refresh();
  };

  const verify = async () => {
    const keys = (await idbKeys('media')).filter((k) => k.startsWith('diag/'));
    let ok = 0;
    for (const k of keys) {
      const p = await idbGet<StoredPhoto>('media', k);
      if (p && (await sha256(await p.blob.arrayBuffer())) === p.sha) ok++;
    }
    add(`照片驗證：${ok}/${keys.length} 張與存入時逐位元相同`);
  };

  const clear = async () => {
    for (const k of (await idbKeys('media')).filter((x) => x.startsWith('diag/'))) await idbDelete('media', k);
    await refresh();
  };

  return (
    <Block title="3. 照片（相機輸入、格式、EXIF、重開後完整）">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png"
        capture="environment"
        className="hidden"
        onChange={(e) => void onFiles(e.target.files)}
      />
      <Btn onClick={() => input.current?.click()}>拍照</Btn>
      <label className="mr-2 mt-1 inline-block rounded bg-stone-600 px-3 py-1.5 text-white">
        從相簿選多張
        <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => void onFiles(e.target.files)} />
      </label>
      <div>已存測試照片：{count ?? '—'} 張</div>
      <Btn onClick={() => void verify()}>重開後驗證</Btn>
      <Btn onClick={() => void clear()}>刪除測試照片</Btn>
    </Block>
  );
}

function ExportBlock({ add }: { add: (s: string) => void }) {
  const [sizeMb, setSizeMb] = useState(300);
  const [url, setUrl] = useState<string | null>(null);

  const make = async (share: boolean) => {
    const t0 = performance.now();
    // Incompressible bytes in 4 MB "photos", stored without compression (as JPEGs will be).
    const files: Record<string, [Uint8Array, { level: 0 }]> = {};
    const per = 4 * 1024 * 1024;
    for (let i = 0; i < Math.ceil((sizeMb * 1e6) / per); i++) {
      const b = new Uint8Array(per);
      for (let off = 0; off < per; off += 65536) crypto.getRandomValues(b.subarray(off, Math.min(off + 65536, per)));
      files[`photos/p${String(i).padStart(4, '0')}.jpg`] = [b, { level: 0 }];
    }
    const zip = zipSync(files);
    const t1 = performance.now();
    const file = new File([zip as BlobPart], `gloria-diag-${sizeMb}MB.zip`, { type: 'application/zip' });
    add(`zip ${mb(zip.byteLength)} 建立 ${ms(t1 - t0)}`);
    if (share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: file.name });
        add(`分享 ${file.name}：完成`);
      } catch (e) {
        add(`分享 ${file.name}：${String(e)}`);
      }
    } else {
      if (share) add('此瀏覽器不支援分享檔案，改用下載連結');
      if (url) URL.revokeObjectURL(url);
      setUrl(URL.createObjectURL(file));
    }
  };

  return (
    <Block title="4. 大檔匯出（分享／下載）">
      <label>
        大小（MB）：
        <input
          type="number"
          className="ml-1 w-24 rounded border px-1"
          value={sizeMb}
          onChange={(e) => setSizeMb(Number(e.target.value) || 1)}
        />
      </label>
      <div>
        <Btn onClick={() => void make(true)}>產生並分享</Btn>
        <Btn onClick={() => void make(false)}>產生下載連結</Btn>
      </div>
      {url ? (
        <a className="text-blue-700 underline" href={url} download={`gloria-diag-${sizeMb}MB.zip`}>
          下載 zip
        </a>
      ) : null}
    </Block>
  );
}

function GbifBlock({ add }: { add: (s: string) => void }) {
  const [key, setKey] = useState('');
  const run = async () => {
    const tryFetch = async (label: string, url: string, init?: RequestInit) => {
      try {
        const r = await fetch(url, init);
        add(`GBIF ${label}: HTTP ${r.status}（瀏覽器讀得到回應＝CORS 允許）`);
      } catch (e) {
        add(`GBIF ${label}: 被擋（${String(e)}）`);
      }
    };
    await tryFetch('物種比對 GET', 'https://api.gbif.org/v1/species/match?name=Abies');
    // Deliberately invalid credentials: a readable 401 proves the preflight passed.
    await tryFetch('下載申請 POST（假帳密，預期 401）', 'https://api.gbif.org/v1/occurrence/download/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${btoa('invalid:invalid')}` },
      body: '{}',
    });
    if (key.trim()) {
      await tryFetch('下載狀態 GET', `https://api.gbif.org/v1/occurrence/download/${encodeURIComponent(key.trim())}`);
      await tryFetch('下載 zip（經 redirect）', `https://api.gbif.org/v1/occurrence/download/request/${encodeURIComponent(key.trim())}`);
    }
  };
  return (
    <Block title="5. GBIF API（CORS）">
      <div className="text-xs">
        只送出公開查詢與一組假帳密；不含任何個人資料。填入一個已完成的 GBIF 下載代碼可測 zip 下載（選填）。
      </div>
      <input
        className="mt-1 w-full rounded border px-1"
        placeholder="下載代碼，例如 0000000-000000000000000"
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <Btn onClick={() => void run()}>測試</Btn>
    </Block>
  );
}

function GeoBlock({ add }: { add: (s: string) => void }) {
  return (
    <Block title="6. 定位（standalone 模式）">
      <Btn
        onClick={() =>
          navigator.geolocation.getCurrentPosition(
            (p) => add(`定位成功，精度 ${p.coords.accuracy.toFixed(0)} m`),
            (e) => add(`定位失敗：${e.message}`),
            { enableHighAccuracy: true, timeout: 30000 },
          )
        }
      >
        取得目前位置
      </Btn>
      <div className="text-xs">只顯示精度，不記錄座標。</div>
    </Block>
  );
}
