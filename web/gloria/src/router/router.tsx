/**
 * Hash router with the expo-router surface the shared GLORIA screens use:
 * `router` / `useRouter` (push, replace, back, canGoBack), `useLocalSearchParams`,
 * `usePathname`, `<Stack.Screen options>` (title, headerTitle, headerLeft,
 * headerRight, headerShown) and `useFocusEffect`.
 *
 * Paths are expo-router paths (`/gloria/12/N11`), kept in the URL hash
 * (`#/gloria/12/N11?x=1`) so GitHub Pages never sees a deep link and offline
 * start needs only index.html. One screen is mounted at a time; going back
 * re-mounts the previous screen, whose useFocusEffect reloads its data — the
 * same contract the mobile screens already follow when they regain focus.
 */
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,

  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { ErrorBoundary } from '../shell/ErrorBoundary';

export type Href = string | { pathname: string; params?: Record<string, string | number | undefined | null> };

// ── Location ──────────────────────────────────────────────────────────────

function currentHash(): string {
  const h = window.location.hash.replace(/^#/, '');
  return h.startsWith('/') ? h : `/${h}`;
}

function hrefToString(href: Href): string {
  if (typeof href === 'string') return href.startsWith('/') ? href : `/${href}`;
  let path = href.pathname;
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(href.params ?? {})) {
    if (v == null) continue;
    if (path.includes(`[${k}]`)) path = path.replace(`[${k}]`, encodeURIComponent(String(v)));
    else query.set(k, String(v));
  }
  const q = query.toString();
  return q ? `${path}?${q}` : path;
}

// Depth within this app's own history, so back() never leaves the app.
// (Guarded: the module is also loaded by tests under Node, without a window.)
const hasWindow = typeof window !== 'undefined';
let depth = hasWindow ? Number(window.history.state?.gloriaDepth ?? 0) : 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
if (hasWindow) {
  window.addEventListener('popstate', () => {
    depth = Number(window.history.state?.gloriaDepth ?? 0);
    notify();
  });
  window.addEventListener('hashchange', notify);
}

export const router = {
  push(href: Href) {
    depth += 1;
    window.history.pushState({ gloriaDepth: depth }, '', `#${hrefToString(href)}`);
    notify();
  },
  navigate(href: Href) {
    router.push(href);
  },
  replace(href: Href) {
    window.history.replaceState({ gloriaDepth: depth }, '', `#${hrefToString(href)}`);
    notify();
  },
  back() {
    if (depth > 0) window.history.back();
    else router.replace('/');
  },
  canGoBack() {
    return depth > 0;
  },
  dismiss() {
    router.back();
  },
  dismissAll() {
    router.replace('/');
  },
  setParams(params: Record<string, string | undefined>) {
    const { path, query } = splitLocation(currentHash());
    for (const [k, v] of Object.entries(params)) {
      if (v == null) query.delete(k);
      else query.set(k, v);
    }
    const q = query.toString();
    router.replace(q ? `${path}?${q}` : path);
  },
};

export function useRouter() {
  return router;
}

function splitLocation(loc: string): { path: string; query: URLSearchParams } {
  const i = loc.indexOf('?');
  return i < 0 ? { path: loc, query: new URLSearchParams() } : { path: loc.slice(0, i), query: new URLSearchParams(loc.slice(i + 1)) };
}

function useLocation(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    currentHash,
    currentHash,
  );
}

// ── Routes ────────────────────────────────────────────────────────────────

export type RouteDef = { pattern: string; load: () => Promise<{ default: ComponentType }> };
type Compiled = { def: RouteDef; re: RegExp; keys: string[]; Comp: ComponentType };

function compile(def: RouteDef): Compiled {
  const keys: string[] = [];
  const re = new RegExp(
    `^${def.pattern
      .split('/')
      .map((seg) => {
        const m = /^\[(\w+)\]$/.exec(seg);
        if (!m) return seg.replace(/[.*+?^${}()|\\]/g, '\\$&');
        keys.push(m[1]);
        return '([^/]+)';
      })
      .join('/')}/?$`,
  );
  return { def, re, keys, Comp: lazy(def.load) };
}

type Match = { route: Compiled; params: Record<string, string>; path: string };
const RouteCtx = createContext<Match | null>(null);

export function useLocalSearchParams<T extends Record<string, string | undefined> = Record<string, string>>(): T {
  const m = useContext(RouteCtx);
  return (m?.params ?? {}) as T;
}
export const useGlobalSearchParams = useLocalSearchParams;

/** The current path, anywhere (also outside the Navigator); re-renders on navigation. */
export function useCurrentPath(): string {
  return splitLocation(useLocation()).path;
}

export function usePathname(): string {
  return useContext(RouteCtx)?.path ?? splitLocation(currentHash()).path;
}

// ── Header (Stack.Screen options) ─────────────────────────────────────────

export type ScreenOptions = {
  title?: string;
  headerTitle?: string | (() => ReactNode);
  headerLeft?: (() => ReactNode) | null;
  headerRight?: (() => ReactNode) | null;
  headerShown?: boolean;
  headerTitleAlign?: 'left' | 'center';
  [k: string]: unknown;
};

/**
 * Header options live outside React state: a screen sets them on every render
 * (its headerRight closes over its latest state), and putting them in the
 * Navigator's state would re-render the screen, which sets them again —
 * an endless loop. Only the header subscribes.
 */
let currentOptions: ScreenOptions = {};
const optionListeners = new Set<() => void>();
function setScreenOptions(o: ScreenOptions | null) {
  currentOptions = o === null ? {} : { ...currentOptions, ...o };
  optionListeners.forEach((l) => l());
}
export function useScreenOptions(): ScreenOptions {
  return useSyncExternalStore(
    (cb) => {
      optionListeners.add(cb);
      return () => optionListeners.delete(cb);
    },
    () => currentOptions,
    () => currentOptions,
  );
}

function ScreenOptionsSetter({ options }: { options?: ScreenOptions | (() => ScreenOptions) }) {
  const o = typeof options === 'function' ? options() : options;
  // Every render: headerRight closures read the screen's latest state.
  useLayoutEffect(() => {
    if (o) setScreenOptions(o);
  });
  return null;
}

export const Stack = Object.assign((_p: { children?: ReactNode }) => null, {
  Screen: ScreenOptionsSetter,
});

// ── Focus ─────────────────────────────────────────────────────────────────

/**
 * Runs on mount (a screen is focused while it is shown) and again when the
 * page becomes visible, so data edited in another window is reloaded.
 */
export function useFocusEffect(effect: () => void | (() => void)): void {
  useEffect(() => {
    let cleanup = effect();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (typeof cleanup === 'function') cleanup();
      cleanup = effect();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (typeof cleanup === 'function') cleanup();
    };
  }, [effect]);
}

export function useIsFocused(): boolean {
  return true;
}

// ── Navigator ─────────────────────────────────────────────────────────────

export function Navigator({
  routes,
  renderHeader,
  notFound,
}: {
  routes: RouteDef[];
  renderHeader: (o: ScreenOptions, canGoBack: boolean, pattern: string) => ReactNode;
  notFound: ComponentType;
}) {
  const compiled = useMemo(() => routes.map(compile), [routes]);
  const loc = useLocation();
  const { path, query } = splitLocation(loc);
  const match = useMemo<Match | null>(() => {
    for (const r of compiled) {
      const m = r.re.exec(path);
      if (!m) continue;
      const params: Record<string, string> = Object.fromEntries(query.entries());
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params, path };
    }
    return null;
  }, [compiled, loc]);
  // New screen, new header (before the screen's own options land).
  useLayoutEffect(() => {
    setScreenOptions(null);
  }, [loc]);
  // Braces matter: window.scrollTo returns a Promise in current Chrome, and an
  // effect that returns one breaks React's cleanup ("destroy is not a function").
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);

  if (!match) {
    const NotFound = notFound;
    return <NotFound />;
  }
  const { Comp } = match.route;
  return (
    <RouteCtx.Provider value={match}>
      <>
        <HeaderSlot render={(o) => renderHeader(o, router.canGoBack(), match.route.def.pattern)} />
        <ErrorBoundary resetKey={loc}>
          <Suspense fallback={null}>
            <Comp key={loc} />
          </Suspense>
        </ErrorBoundary>
      </>
    </RouteCtx.Provider>
  );
}

function HeaderSlot({ render }: { render: (o: ScreenOptions) => ReactNode }) {
  const o = useScreenOptions();
  return o.headerShown === false ? null : <>{render(o)}</>;
}
