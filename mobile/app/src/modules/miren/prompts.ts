/**
 * The short create flows of the MIREN screens: new region, new route, new
 * survey. Cross-platform sheets and prompts only (showActionSheet /
 * promptText), as the app requires.
 */
import { Alert } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { promptText } from '~/components/TextPromptModal';
import { startMirenAndOpen } from '~/lib/recordCreate';
import i18n from '~/i18n';
import { createRegion, createRoute, regionCodeFor, type MirenRegion } from './db';
import { REGION_CODE_LENGTH, type RouteKind } from './model/codes';

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);

async function pickKind(title: string, message: string, kinds: RouteKind[]): Promise<RouteKind | null> {
  if (kinds.length === 1) return kinds[0];
  const idx = await showActionSheet({
    title,
    message,
    options: kinds.map((k) => ({ label: t(k === 'road' ? 'miren.kind.road' : 'miren.kind.trail') })),
    cancelLabel: t('common.cancel'),
  });
  return kinds[idx] ?? null;
}

/** Ask which kind of region code, then the code. Returns the new region id. */
export async function promptNewRegion(): Promise<number | null> {
  const kind = await pickKind(t('miren.regions.newTitle'), t('miren.regions.newMsg'), ['road', 'trail']);
  if (!kind) return null;
  const n = REGION_CODE_LENGTH[kind];
  const code = await promptText({
    title: t('miren.regions.newTitle'),
    message: t('miren.regions.codeMsg', { n }),
    placeholder: kind === 'road' ? 'MTN' : 'AU',
    autoCapitalize: 'characters',
  });
  if (!code) return null;
  const r = createRegion(kind === 'road' ? { code_road: code, code_trail: null } : { code_road: null, code_trail: code });
  if (!r.ok) {
    Alert.alert(t('miren.code.refused'), t(r.error === 'taken' ? 'miren.code.taken' : 'miren.code.invalid', { n }));
    return null;
  }
  return r.id;
}

/** A new road or trail in a region; only kinds the region has a code for. */
export async function promptNewRoute(region: MirenRegion): Promise<number | null> {
  const kinds = (['road', 'trail'] as const).filter((k) => regionCodeFor(region, k));
  const kind = await pickKind(t('miren.region.newRoute'), t('miren.region.newRouteMsg'), [...kinds]);
  if (!kind) return null;
  const code = await promptText({
    title: t(kind === 'road' ? 'miren.region.newRoad' : 'miren.region.newTrail'),
    message: t('miren.region.routeCodeMsg'),
    placeholder: 'BP',
    autoCapitalize: 'characters',
  });
  if (!code) return null;
  const r = createRoute(region.id, kind, code);
  if (!r.ok) {
    Alert.alert(t('miren.code.refused'), t(r.error === 'taken' ? 'miren.code.routeTaken' : 'miren.code.routeInvalid'));
    return null;
  }
  return r.id;
}

/** Ask the survey year (default: this year) and start it. */
export async function promptStartSurvey(routeId: number): Promise<void> {
  const now = new Date().getFullYear();
  const raw = await promptText({
    title: t('miren.route.newSurvey'),
    message: t('miren.route.yearMsg'),
    placeholder: String(now),
    defaultValue: String(now),
    keyboardType: 'numeric',
  });
  if (raw == null) return;
  const year = Number(raw.trim());
  const r = await startMirenAndOpen(routeId, year);
  if (r === 'taken') Alert.alert(t('miren.route.newSurvey'), t('miren.route.yearTaken', { year }));
  if (r === 'no-sites') Alert.alert(t('miren.route.newSurvey'), t('miren.route.noSites'));
  if (r === 'invalid') Alert.alert(t('miren.route.newSurvey'), t('miren.route.yearInvalid'));
}

