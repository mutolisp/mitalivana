/**
 * Lets the web build import the mobile app's pure and DB-layer modules
 * unchanged, while keeping every native dependency out of the bundle.
 *
 * Three jobs:
 *   1. `~/x` resolves to `mobile/app/src/x` (same alias the mobile app uses).
 *   2. A few mobile files are swapped for web hosts by *resolved path*, so a
 *      relative `./init` import inside `src/db/` is caught as well as `~/db/init`.
 *      Bare native packages that reused modules really need get small shims.
 *   3. Anything else native (react-native, expo-*, @expo/*, @op-engineering/*)
 *      fails the build with the importer chain, so a mobile change that pulls
 *      native code into a shared module is noticed here, not on a phone.
 *
 * Used by both `vite build` and vitest (vitest reads vite.config.ts).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(here, '..');
export const MOBILE_SRC = path.resolve(WEB_ROOT, '../../mobile/app/src');
const HOST = path.resolve(WEB_ROOT, 'src/host');

/** Mobile file (resolved) → web replacement. */
const REPLACE: Record<string, string> = {
  [path.join(MOBILE_SRC, 'db/init.ts')]: path.join(HOST, 'dbInit.ts'),
  [path.join(MOBILE_SRC, 'lib/appFiles.ts')]: path.join(HOST, 'appFiles.ts'),
  [path.join(MOBILE_SRC, 'i18n/index.ts')]: path.join(HOST, 'i18n.ts'),
  // Pulls every record kind and team crypto into the bundle; no-op on the web for now.
  [path.join(MOBILE_SRC, 'db/recordVersions.ts')]: path.join(HOST, 'recordVersions.ts'),
  // Creates and imports every record kind; the web app has GLORIA only.
  [path.join(MOBILE_SRC, 'lib/recordCreate.ts')]: path.join(HOST, 'recordCreate.ts'),
  // formatBytes only; the size estimate needs the photo library (bundleExport).
  [path.join(MOBILE_SRC, 'lib/exportSize.ts')]: path.join(HOST, 'exportSize.ts'),
  // Native media, files and pickers; web versions keep the same exports.
  [path.join(MOBILE_SRC, 'lib/photoCapture.ts')]: path.join(HOST, 'photoCapture.ts'),
  [path.join(MOBILE_SRC, 'lib/fileAttach.ts')]: path.join(HOST, 'fileAttach.ts'),
  [path.join(MOBILE_SRC, 'lib/bundleExport.ts')]: path.join(HOST, 'bundleExport.ts'),
  [path.join(MOBILE_SRC, 'components/DateTimeField.tsx')]: path.join(HOST, 'dateTimeField.tsx'),
  // Team sync / merge log / versions are not on the web; adds GLORIA export.
  [path.join(MOBILE_SRC, 'components/RecordMenuButton.tsx')]: path.join(HOST, 'recordMenuButton.tsx'),
  // KML/GPX/WKT parsing for checklist and plot imports; GLORIA imports never reach it.
  [path.join(MOBILE_SRC, 'lib/geoConverters.ts')]: path.join(HOST, 'geoConverters.ts'),
  // Lazily require()d by datasets.ts; a native module (expo-modules-core).
  [path.resolve(MOBILE_SRC, '../modules/backup-exclusion/index.ts')]: path.join(HOST, 'backupExclusion.ts'),
};

/** Bare native package → web shim. Only what reused modules actually call. */
const SHIMS: Record<string, string> = {
  '@op-engineering/op-sqlite': path.join(HOST, 'opSqlite.ts'),
  'expo-file-system': path.join(HOST, 'expoFs.ts'),
  'expo-router': path.join(HOST, 'expoRouter.ts'),
  nativewind: path.join(HOST, 'nativewind.ts'),
  // Voice-input phonetic search only (fuzzy.ts catches the throw).
  'pinyin-pro': path.join(HOST, 'pinyinPro.ts'),
  // React Native itself is the rn/ layer: importing an API it does not
  // implement (Animated, NativeModules…) is a missing-export build error.
  'react-native': path.join(WEB_ROOT, 'src/rn/index.ts'),
  '@expo/vector-icons': path.join(WEB_ROOT, 'src/rn/vectorIcons.ts'),
  'react-native-safe-area-context': path.join(HOST, 'safeArea.tsx'),
  'react-native-keyboard-controller': path.join(HOST, 'keyboardController.tsx'),
  'expo-haptics': path.join(HOST, 'haptics.ts'),
  'expo-location': path.join(HOST, 'location.ts'),
  'react-native-svg': path.join(HOST, 'svg.tsx'),
  'expo-image': path.join(HOST, 'expoImage.tsx'),
  'react-native-reanimated': path.join(HOST, 'reanimated.tsx'),
  'react-native-gesture-handler': path.join(HOST, 'gestureHandler.tsx'),
  'react-native-gesture-handler/Swipeable': path.join(HOST, 'swipeable.tsx'),
  'react-native-draggable-flatlist': path.join(HOST, 'draggableFlatList.tsx'),
  '@rn-primitives/select': path.join(HOST, 'rnPrimitivesSelect.tsx'),
  'expo-document-picker': path.join(HOST, 'documentPicker.ts'),
  'expo-sharing': path.join(HOST, 'sharing.ts'),
  'expo-file-system/legacy': path.join(HOST, 'expoFsLegacy.ts'),
};

const FORBIDDEN = /^(react-native($|[-/])|expo($|[-/])|@expo\/|@op-engineering\/|@react-native)/;


export function mobileBridge(): Plugin {
  // child id → first importer, to print the chain when the guard trips.
  const importerOf = new Map<string, string>();
  // GLORIA_BRIDGE_REPORT=1: list every native import instead of failing on the first
  // (to size up what a newly shared screen needs). Never set in CI.
  const report = process.env.GLORIA_BRIDGE_REPORT === '1';
  const found = new Map<string, Set<string>>();

  const chain = (start: string | undefined): string[] => {
    const out: string[] = [];
    let cur = start;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      out.push(path.relative(path.resolve(WEB_ROOT, '../..'), cur));
      cur = importerOf.get(cur);
    }
    return out;
  };

  return {
    name: 'gloria-mobile-bridge',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source.startsWith('\0')) return null;
      if (SHIMS[source]) return SHIMS[source];
      if (FORBIDDEN.test(source)) {
        if (report) {
          if (!found.has(source)) found.set(source, new Set());
          found.get(source)!.add(chain(importer).slice(0, 6).join(' ← '));
          return { id: `\0native:${source}`, external: true };
        }
        this.error(
          `[mobile-bridge] native import "${source}" reached the web bundle via:\n  ` +
            chain(importer).join('\n  ← '),
        );
      }
      let target = source;
      if (source.startsWith('~/')) target = path.join(MOBILE_SRC, source.slice(2));
      const resolved = await this.resolve(target, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external) return resolved;
      const id = resolved.id.split('?')[0];
      if (importer && !importerOf.has(id)) importerOf.set(id, importer);
      const swap = REPLACE[id];
      if (swap) {
        if (importer && !importerOf.has(swap)) importerOf.set(swap, importer);
        return swap;
      }
      return target === source ? null : resolved;
    },
    buildEnd() {
      if (!report) return;
      for (const [mod, from] of [...found.entries()].sort()) console.log(`${mod}\n    ← ${[...from].sort().join('\n    ← ')}`);
    },
  };
}

/**
 * Packages that mobile sources import must resolve from web/gloria/node_modules,
 * not mobile/app/node_modules (CI never installs the latter).
 */
export const DEDUPE = [
  'react',
  'react-dom',
  'zustand',
  'i18next',
  'react-i18next',
  'fflate',
  'js-yaml',
  '@noble/hashes',
  'fastest-levenshtein',
  '@xmldom/xmldom',
];
