/**
 * Web replacement for mobile/app/src/i18n/index.ts.
 *
 * Same i18next instance shape and the same locale files (read from the mobile
 * tree), so `t('gloria.…')` keys are shared verbatim. zh-TW and en are bundled;
 * the other languages load on demand. Device locale comes from
 * `navigator.languages` instead of the native module.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhTW from '~/i18n/locales/zh-TW.json';
import en from '~/i18n/locales/en.json';
import webZhTW from '../i18n/web/zh-TW.json';
import webEn from '../i18n/web/en.json';

export const SUPPORTED_LANGUAGES = ['en', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'es-419'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_CATALOGUE: Array<{ value: SupportedLanguage; native: string; english: string }> = [
  { value: 'zh-TW', native: '正體中文', english: 'Traditional Chinese' },
  { value: 'en', native: 'English', english: 'English' },
  { value: 'ja', native: '日本語', english: 'Japanese' },
  { value: 'ko', native: '한국어', english: 'Korean' },
  { value: 'de', native: 'Deutsch', english: 'German' },
  { value: 'fr', native: 'Français', english: 'French' },
  { value: 'es', native: 'Español', english: 'Spanish' },
  { value: 'es-419', native: 'Español (Latinoamérica)', english: 'Spanish (Latin America)' },
];

const LATIN_AMERICA_ES = new Set([
  'MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'GT', 'CU', 'BO', 'DO', 'HN', 'PY', 'SV', 'NI', 'CR', 'PA', 'UY', 'PR', 'US', '419',
]);

function matchLocale(locale: string): SupportedLanguage | null {
  const l = locale.toLowerCase();
  // Every Chinese locale gets Traditional Chinese (Taiwan); there is no Simplified version.
  if (l.startsWith('zh')) return 'zh-TW';
  for (const code of ['en', 'ja', 'ko', 'de', 'fr'] as const) if (l.startsWith(code)) return code;
  if (l.startsWith('es')) {
    const region = locale.split(/[-_]/)[1]?.toUpperCase() ?? '';
    return LATIN_AMERICA_ES.has(region) ? 'es-419' : 'es';
  }
  return null;
}

export function deviceLanguage(): SupportedLanguage | null {
  const list = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [];
  for (const l of list) {
    const m = l && matchLocale(l);
    if (m) return m;
  }
  return null;
}

export function resolveLanguage(setting: string): SupportedLanguage {
  if (setting !== 'system' && (SUPPORTED_LANGUAGES as readonly string[]).includes(setting)) return setting as SupportedLanguage;
  return deviceLanguage() ?? 'zh-TW';
}

const lazy: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  ja: () => import('~/i18n/locales/ja.json'),
  ko: () => import('~/i18n/locales/ko.json'),
  de: () => import('~/i18n/locales/de.json'),
  fr: () => import('~/i18n/locales/fr.json'),
  es: () => import('~/i18n/locales/es.json'),
  'es-419': () => import('~/i18n/locales/es-419.json'),
};
// zh-TW and en overlays are bundled above; only the other languages load lazily.
const webLazy = import.meta.glob<{ default: Record<string, unknown> }>([
  '../i18n/web/*.json',
  '!../i18n/web/zh-TW.json',
  '!../i18n/web/en.json',
]);

/** Make sure a language's strings are loaded, then switch to it. */
export async function setLanguage(lang: SupportedLanguage): Promise<void> {
  const chain = lang === 'es-419' ? ['es', 'es-419'] : [lang];
  for (const l of chain) {
    if (!i18n.hasResourceBundle(l, 'translation') && lazy[l]) {
      const base = (await lazy[l]()).default;
      const webMod = webLazy[`../i18n/web/${l}.json`];
      const web = webMod ? (await webMod()).default : {};
      i18n.addResourceBundle(l, 'translation', { ...base, ...web }, true, true);
    }
  }
  await i18n.changeLanguage(lang);
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

i18n.use(initReactI18next).init({
  resources: {
    'zh-TW': { translation: { ...zhTW, ...webZhTW } },
    en: { translation: { ...en, ...webEn } },
  },
  lng: deviceLanguage() === 'en' ? 'en' : 'zh-TW',
  fallbackLng: { 'es-419': ['es', 'zh-TW'], default: ['zh-TW'] },
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
