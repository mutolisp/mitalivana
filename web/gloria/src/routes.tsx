/**
 * Route table: expo-router paths of the shared mobile GLORIA screens (the
 * files under mobile/app/app/gloria are the screens themselves) plus the web
 * app's own pages. Titles are the ones mobile registers in app/_layout.tsx.
 */
import type { RouteDef } from './router/router';
import i18n from './host/i18n';

export type AppRoute = RouteDef & { title?: () => string };

export const ROUTES: AppRoute[] = [
  { pattern: '/', load: () => import('./screens/Home') },
  { pattern: '/diag', load: () => import('./diag/DiagnosticsScreen') },
  { pattern: '/gloria/new', load: () => import('../../../mobile/app/app/gloria/new'), title: () => i18n.t('gloria.new.title') },
  { pattern: '/gloria/summit-new', load: () => import('../../../mobile/app/app/gloria/summit-new'), title: () => i18n.t('gloria.new.addSummit') },
  { pattern: '/gloria/summits', load: () => import('../../../mobile/app/app/gloria/summits'), title: () => i18n.t('gloria.summitImport.listTitle') },
  { pattern: '/gloria/summit-import', load: () => import('../../../mobile/app/app/gloria/summit-import'), title: () => i18n.t('gloria.summitImport.reviewTitle') },
  { pattern: '/gloria/summit/[id]', load: () => import('../../../mobile/app/app/gloria/summit/[id]'), title: () => '' },
  { pattern: '/gloria/logger/[visitId]', load: () => import('../../../mobile/app/app/gloria/logger/[visitId]'), title: () => i18n.t('gloria.tab.loggers') },
  { pattern: '/gloria/[id]/points-import', load: () => import('../../../mobile/app/app/gloria/[id]/points-import'), title: () => i18n.t('gloria.pointImport.reviewTitle') },
  // A unit code segment must not swallow fixed routes: these come after points-import.
  { pattern: '/gloria/[id]/[code]/frequency', load: () => import('../../../mobile/app/app/gloria/[id]/[code]/frequency') },
  { pattern: '/gloria/[id]/[code]/points', load: () => import('../../../mobile/app/app/gloria/[id]/[code]/points') },
  { pattern: '/gloria/[id]/[code]/species/[usid]', load: () => import('../../../mobile/app/app/gloria/[id]/[code]/species/[usid]') },
  { pattern: '/gloria/[id]/[code]', load: () => import('../../../mobile/app/app/gloria/[id]/[code]/index') },
  // Last among /gloria/*: a summit code segment must not swallow the fixed routes above.
  { pattern: '/gloria/[id]', load: () => import('../../../mobile/app/app/gloria/[id]/index') },
  { pattern: '/report/[kind]/[id]', load: () => import('../../../mobile/app/app/report/[kind]/[id]'), title: () => i18n.t('report.navTitle') },
];
