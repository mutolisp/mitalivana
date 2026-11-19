/**
 * App shell: boot the database (tab lock, snapshot, migrations), mount the
 * stored species database, load settings, then the router with the shared
 * GLORIA screens. Hosts the overlays the mobile root layout hosts too
 * (action sheets, toasts) plus RN Alert dialogs and the update prompt.
 */
import { useEffect, useMemo, useState } from 'react';
import { bootDatabase, type BootResult } from './host/boot';
import { bootPacks } from './host/packsHost';
import { mountStoredSpecies } from './host/speciesInstall';
import { initDatasetsEmpty } from './host/datasetsHost';
import { flushOnHide, requestPersistence } from './host/persist';
import i18n, { resolveLanguage, setLanguage } from './host/i18n';
import { useSettings } from '~/stores/settings';
import { useActiveGloria } from '~/modules/gloria/store';
import { ActionSheetLayer } from '~/components/ActionSheet';
import { ToastHost } from '~/components/ToastHost';
import { MenuHost } from '~/components/OverflowMenu';
import { AlertHost } from './rn/AlertHost';
import { Navigator } from './router/router';
import { ROUTES } from './routes';
import { Header } from './shell/Header';
import { setBoot } from './shell/bootStore';
import { UpdatePrompt } from './UpdatePrompt';
import { SurveySidebar, surveyRoute, useDesktopKeys, useWide } from './shell/Desktop';
import { useCurrentPath } from './router/router';

type Failure = Extract<BootResult, { ok: false }>;

/**
 * Start-up runs once per page, whatever React does with effects (StrictMode
 * runs them twice in development; a second run would find its own tab lock
 * taken and report "open in another tab").
 */
let booting: Promise<{ failure: Failure } | { ok: true }> | null = null;
function bootOnce() {
  booting ??= (async () => {
    const t0 = performance.now();
    initDatasetsEmpty();
    const result = await bootDatabase();
    const t1 = performance.now();
    if (!result.ok) return { failure: result };
    flushOnHide([await bootPacks()]);
    const species = await mountStoredSpecies();
    const t2 = performance.now();
    useSettings.getState().load();
    useActiveGloria.getState().refresh();
    const lang = useSettings.getState().language;
    if (lang && lang !== 'system') await setLanguage(resolveLanguage(lang));
    void requestPersistence();
    setBoot({
      flusher: result.flusher,
      timings: { bootMs: t1 - t0, speciesMountMs: t2 - t1 },
      species,
      recoveredFromPrev: result.recoveredFromPrev,
    });
    return { ok: true as const };
  })();
  return booting;
}

export function App() {
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    bootOnce().then(
      (r) => {
        if (cancelled) return;
        if ('failure' in r) setFailure(r.failure);
        else setReady(true);
      },
      (e: unknown) => !cancelled && setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const titles = useMemo(() => new Map(ROUTES.map((r) => [r.pattern, r.title])), []);
  const wide = useWide();
  const path = useCurrentPath();
  useDesktopKeys();

  if (error) return <Message>Start-up failed: {error}</Message>;
  if (failure) {
    const key = { 'other-tab': 'otherTab', 'newer-schema': 'newerSchema', corrupt: 'corrupt' }[failure.reason];
    return (
      <Message>
        {i18n.t(`web.home.${key}`)}
        {failure.detail ? <pre className="mt-2 text-xs">{failure.detail}</pre> : null}
      </Message>
    );
  }
  if (!ready) return null;
  const survey = surveyRoute(path);

  return (
    // The shared screens are laid out for a phone: they keep a phone-width
    // column; on a wide screen a survey's pages get the unit sidebar beside it.
    // The column is exactly the viewport's height, as a phone screen is: a
    // screen scrolls inside itself (its ScrollView), its bottom bar stays at
    // the bottom, and an overlay over the screen covers what is in view.
    <div className="flex h-full w-full justify-center overflow-hidden">
      {wide && survey ? <SurveySidebar surveyId={survey.id} current={survey.code} /> : null}
    <div className="flex h-full min-h-0 w-full max-w-2xl flex-col bg-paper dark:bg-paper-dark" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <Navigator
        routes={ROUTES}
        notFound={() => <Message>404</Message>}
        renderHeader={(options, _canGoBack, pattern) => (
          <Header options={options} defaultTitle={titles.get(pattern)?.()} isRoot={pattern === '/'} />
        )}
      />
      <MenuHost />
      <ActionSheetLayer />
      <ToastHost />
      <AlertHost />
      <UpdatePrompt />
    </div>
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-2xl p-6 text-ink dark:text-gray-100">{children}</main>;
}
