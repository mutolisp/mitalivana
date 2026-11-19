/**
 * Shell for the foundations phase: boots the database (tab lock, snapshot,
 * migrations), mounts the stored species database, and offers the phase-0
 * device diagnostics at #/diag. Field screens arrive in phase 2.
 */
import { useEffect, useState } from 'react';
import { bootDatabase, type BootResult } from './host/boot';
import { mountStoredSpecies } from './host/speciesInstall';
import { initDatasetsEmpty } from './host/datasetsHost';
import { requestPersistence } from './host/persist';
import { listSummits } from '~/modules/gloria/db';
import { Diagnostics, type BootTimings } from './diag/Diagnostics';
import { UpdatePrompt } from './UpdatePrompt';
// Phase 2 screens call these; imported here so the build guard covers them now.
export { buildSurveyZip } from './export/exportSurvey';
export { readGloriaImport, applyGloriaImport } from './import/importZip';

type Boot = { result: BootResult; timings: BootTimings; speciesVersion: string | null };

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hash = useHash();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t0 = performance.now();
      initDatasetsEmpty();
      const result = await bootDatabase();
      const t1 = performance.now();
      let speciesVersion: string | null = null;
      if (result.ok) speciesVersion = await mountStoredSpecies();
      const t2 = performance.now();
      if (result.ok) void requestPersistence();
      if (!cancelled) setBoot({ result, speciesVersion, timings: { bootMs: t1 - t0, speciesMountMs: t2 - t1 } });
    })().catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Shell>啟動失敗（Start-up failed）：{error}</Shell>;
  if (!boot) return <Shell>開啟資料庫中…</Shell>;
  if (!boot.result.ok) {
    const msg = {
      'other-tab': '這個 app 已在另一個分頁或視窗開啟。請關閉其他分頁後重新整理。',
      'newer-schema': '資料是由較新版本的 app 存的，請重新整理以更新 app。',
      corrupt: '資料庫快照無法讀取。請不要清除網站資料，並與開發者聯絡。',
    }[boot.result.reason];
    return (
      <Shell>
        {msg}
        {boot.result.detail ? <pre className="mt-2 text-xs">{boot.result.detail}</pre> : null}
      </Shell>
    );
  }

  return (
    <>
      <UpdatePrompt flusher={boot.result.flusher} />
      {hash.startsWith('#/diag') ? (
        <Diagnostics flusher={boot.result.flusher} timings={boot.timings} speciesVersion={boot.speciesVersion} />
      ) : (
        <Shell>
          <h1 className="text-xl font-semibold">GLORIA 山峰監測（網頁版）</h1>
          <p className="mt-2">山峰數：{listSummits().length}</p>
          {boot.result.recoveredFromPrev ? <p className="mt-2 text-amber-700">已從前一份快照復原資料。</p> : null}
          <p className="mt-4">
            <a className="text-blue-700 underline" href="#/diag">
              實機診斷（Phase 0）
            </a>
          </p>
        </Shell>
      )}
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-2xl p-4 font-sans">{children}</main>;
}
