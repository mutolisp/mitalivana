/**
 * Desktop layout (wide screens): on a survey's pages, a sidebar with all 28
 * units by direction and their status, next to the phone-width screen; and
 * keyboard shortcuts for entering paper forms.
 *
 *   /            focus the species search
 *   Alt+← / →    previous / next unit (sidebar order)
 *   Alt+↑ / ↓    move a species row (draggableFlatList.tsx)
 *   frequency:   two digits = row then column (1–9, 0 = 10th) toggles that
 *                cell through the screen's own R / C keypad; Esc clears
 *
 * The shortcuts drive the shared screens through their own controls (the
 * keypad buttons, the search box), so nothing about recording changes.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ALL_UNITS, DIRECTIONS } from '~/modules/gloria/model/units';
import { useSurvey } from '~/modules/gloria/useSurvey';
import { statusLook } from '~/modules/gloria/statusColors';
import { useThemeColors } from '~/theme/colors';
import { router, useCurrentPath } from '../router/router';
import { useBoot } from './bootStore';

const WIDE = '(min-width: 1100px)';

export function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const q = window.matchMedia(WIDE);
      q.addEventListener('change', cb);
      return () => q.removeEventListener('change', cb);
    },
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

/** `/gloria/12/E11/frequency` → { id: 12, code: 'E11', rest: 'frequency' }. */
export function surveyRoute(path: string): { id: number; code: string | null; rest: string | null } | null {
  const m = /^\/gloria\/(\d+)(?:\/([A-Z0-9]+))?(?:\/([a-z]+))?/.exec(path);
  if (!m) return null;
  const code = m[2] && ALL_UNITS.some((u) => u.code === m[2]) ? m[2] : null;
  return { id: Number(m[1]), code, rest: m[3] ?? null };
}

const ORDER = DIRECTIONS.flatMap((d) => ALL_UNITS.filter((u) => u.direction === d).map((u) => u.code));

export function SurveySidebar({ surveyId, current }: { surveyId: number; current: string | null }) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const { state, reload } = useSurvey(surveyId);
  const flusher = useBoot()?.flusher;
  const path = useCurrentPath();
  // Statuses follow edits in the main pane: reload on navigation and after saves.
  useEffect(() => reload(), [path, reload]);
  useEffect(() => flusher?.subscribe((s) => s === 'saved' && reload()), [flusher, reload]);
  if (!state) return null;
  const group = (label: string, codes: string[]) => (
    <div className="mt-2">
      <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3 dark:text-gray-400">{label}</div>
      <div className="mt-1 grid grid-cols-4 gap-1">
        {codes.map((code) => {
          const look = statusLook(c, state.statusOf(code));
          const on = code === current;
          return (
            <button
              key={code}
              onClick={() => (current ? router.replace(`/gloria/${surveyId}/${code}`) : router.push(`/gloria/${surveyId}/${code}`))}
              title={t(`gloria.status.${state.statusOf(code)}`)}
              className={`rounded-md px-1 py-1 font-mono text-xs font-bold ${on ? 'ring-2 ring-ink dark:ring-gray-100' : ''}`}
              style={{ background: look.fill, color: look.onFill, border: look.border ? `1px solid ${look.border}` : undefined }}
            >
              {code}
            </button>
          );
        })}
      </div>
    </div>
  );
  return (
    <nav className="sticky top-0 flex h-screen w-64 shrink-0 flex-col overflow-y-auto border-r border-line bg-card p-3 dark:border-line-dark dark:bg-card-dark">
      <button className="text-left" onClick={() => router.push(`/gloria/${surveyId}`)}>
        <div className="font-mono text-sm font-bold text-ink dark:text-gray-100">
          {state.summit.full_code} · mocy {state.survey.mocy}
        </div>
        <div className="text-xs text-accent underline dark:text-emerald-400">{t('gloria.tab.map')}</div>
      </button>
      {DIRECTIONS.map((d) => (
        <div key={d} className="mt-3">
          <div className="text-sm font-bold text-ink dark:text-gray-100">{d}</div>
          {group(t('gloria.list.quadrats'), ALL_UNITS.filter((u) => u.direction === d && u.type === 'quadrat').map((u) => u.code))}
          {group('SAS', ALL_UNITS.filter((u) => u.direction === d && u.type === 'sas').map((u) => u.code))}
          {group('10×10 m', ALL_UNITS.filter((u) => u.direction === d && u.type === 'square').map((u) => u.code))}
        </div>
      ))}
      <p className="mt-auto pt-4 text-[11px] leading-snug text-ink-3 dark:text-gray-400">{t('web.desktop.keys')}</p>
    </nav>
  );
}

const typing = (el: Element | null) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable);

function clickByLabel(label: string): boolean {
  const el = [...document.querySelectorAll<HTMLElement>('[aria-label]')].find((e) => e.getAttribute('aria-label') === label);
  el?.click();
  return !!el;
}

/** Keyboard shortcuts; active on every screen, each one only where it applies. */
export function useDesktopKeys() {
  const { t } = useTranslation();
  const path = useCurrentPath();
  const [rowNext, setRowNext] = useState(true);
  useEffect(() => setRowNext(true), [path]);
  useEffect(() => {
    const r = surveyRoute(path);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === '/' && !typing(document.activeElement)) {
        const box = document.querySelector<HTMLInputElement>(`input[aria-label="${t('search.placeholder')}"], input[placeholder="${t('search.placeholder')}"]`);
        if (box) {
          e.preventDefault();
          box.focus();
        }
        return;
      }
      if (e.altKey && r?.code && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing(document.activeElement)) {
        const i = ORDER.indexOf(r.code);
        const next = ORDER[(i + (e.key === 'ArrowRight' ? 1 : ORDER.length - 1)) % ORDER.length];
        e.preventDefault();
        router.replace(`/gloria/${r.id}/${next}${r.rest ? `/${r.rest}` : ''}`);
        return;
      }
      if (r?.rest === 'frequency' && !typing(document.activeElement) && !e.altKey && !e.metaKey && !e.ctrlKey) {
        if (e.key === 'Escape') {
          setRowNext(true);
          return;
        }
        if (/^[0-9]$/.test(e.key)) {
          const n = e.key === '0' ? 10 : Number(e.key);
          const label = t(rowNext ? 'plot.quadrats.keypadRow' : 'plot.quadrats.keypadCol', { n });
          if (clickByLabel(label)) {
            e.preventDefault();
            setRowNext(!rowNext);
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [path, rowNext, t]);
}
