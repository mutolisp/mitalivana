/**
 * Expo dynamic config. Replaces `app.json` to read secrets from env vars at
 * prebuild time, so credentials (e.g. Google Maps API key) never enter git.
 *
 * Sources read by Expo CLI:
 *   - Local dev: `.env` file at this directory (gitignored). See `.env.example`.
 *   - EAS cloud build: secrets set via `eas secret:create --name X --type string`
 *     or via EAS Dashboard → Project Settings → Secrets. `.env` is NOT pulled
 *     from git into EAS, so secrets MUST be configured separately on EAS — a
 *     missing secret causes the conditional native config to be skipped, which
 *     surfaces as runtime errors (e.g. "API key not found" on map load).
 *
 * 名錄資料**不隨 app 出貨**（0.6 起改為從 R2 下載，見 src/lib/datasetInstall.ts），
 * 所以這裡不再有 expo-asset 的 DB 條目；安裝檔因此從 ~170 MB 降到十幾 MB。
 *
 * Required env vars:
 *   - GOOGLE_MAPS_ANDROID_API_KEY  → injected into AndroidManifest as
 *     com.google.android.geo.API_KEY (only needed for Android; iOS uses
 *     Apple Maps, no key required).
 *   - GOOGLE_OAUTH_DEVICE_CLIENT_ID / _SECRET → `extra.googleOauth`, read at
 *     RUNTIME by googleAuth.ts (not native config like the Maps key, hence
 *     `extra` rather than a plugin). OAuth client type "TVs and Limited Input
 *     devices". The secret is not a secret in an installed app — see the file
 *     header of googleAuth.ts — but it still goes through .env / EAS secrets
 *     so it is not committed.
 *   - ORCID_CLIENT_ID / ORCID_REDIRECT_URI / ORCID_BASE → `extra.orcid`, read at
 *     runtime by the provenance screen (src/lib/orcidAuth.ts). A **Public API**
 *     client from the signer's own ORCID Developer Tools — no membership
 *     needed. The redirect URI must be HTTPS and registered on that client;
 *     the app intercepts it in a WebView and never loads it. ORCID_BASE
 *     defaults to https://orcid.org; set https://sandbox.orcid.org to test.
 *
 * Missing vars don't crash the build, but the corresponding native config is
 * omitted (e.g. Android map tab will be blank if the key is absent).
 */
import type { ExpoConfig } from 'expo/config';

const GOOGLE_MAPS_ANDROID_API_KEY = process.env.GOOGLE_MAPS_ANDROID_API_KEY;
const GOOGLE_OAUTH_DEVICE_CLIENT_ID = process.env.GOOGLE_OAUTH_DEVICE_CLIENT_ID;
const GOOGLE_OAUTH_DEVICE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_DEVICE_CLIENT_SECRET;
const ORCID_CLIENT_ID = process.env.ORCID_CLIENT_ID;
const ORCID_REDIRECT_URI = process.env.ORCID_REDIRECT_URI;
const ORCID_BASE = process.env.ORCID_BASE;

const config: ExpoConfig = {
  name: 'Mitalivana',
  slug: 'checklister-mobile',
  version: '0.5.4',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'checklister',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'tw.edu.ntu.checklister',
    // ios/ and android/ are committed prebuild artifacts, so the build numbers
    // live in two places. Declaring them here as well means a future
    // `expo prebuild` regenerates the same values instead of silently
    // resetting them to 1 — which App Store Connect would reject, and which
    // Play would treat as a downgrade.
    buildNumber: '29',
    infoPlist: {
      // App uses only standard HTTPS encryption (exempt). Declaring this
      // skips the export-compliance prompt on every App Store Connect upload.
      ITSAppUsesNonExemptEncryption: false,
      // MapLibre Native 用裝置字型算繪中日韓字，不必自架 30-60 MB 的 CJK glyph。
      // 沒設這個鍵它會 fallback 到系統字型（MLNRendererConfiguration.m），指定
      // PingFang TC 只是讓字形更貼近繁中排版。Android 對應的預設是 sans-serif。
      MLNIdeographicFontFamilyName: ['PingFang TC', 'Heiti TC', 'sans-serif'],
    },
  },
  android: {
    package: 'tw.checklister.mobile',
    // Aligned with the iOS build number so "build 21" means one thing on both
    // platforms. Nothing is published to Play yet, so raising it from 2 costs
    // nothing; versionCode only has to increase.
    versionCode: 29,
    adaptiveIcon: {
      backgroundColor: '#F5EBD9',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    ...(GOOGLE_MAPS_ANDROID_API_KEY
      ? { config: { googleMaps: { apiKey: GOOGLE_MAPS_ANDROID_API_KEY } } }
      : {}),
  },
  web: {
    output: 'static',
    favicon: './assets/images/favicon.png',
  },
  plugins: [
    './plugins/withBackupExclusions',
    // Pods keep their own (often ancient) deployment targets; Xcode 27 refuses
    // anything below 15.0. This used to be a hand-edited `post_install` block
    // in ios/Podfile — which `expo prebuild --clean` silently regenerates away.
    ['./plugins/withPodMinDeploymentTarget', { minTarget: '15.1' }],
    // 向量地圖引擎。加了它就必須重建 dev client（不能用 Expo Go）。
    '@maplibre/maplibre-react-native',
    'expo-router',
    'react-native-edge-to-edge',
    [
      'expo-splash-screen',
      {
        image: './assets/images/splash-icon.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: '#F5EBD9',
        dark: {
          backgroundColor: '#1F1814',
        },
      },
    ],
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          'Allow Mitalivana to record locations of species observations (foreground use is sufficient).',
        locationWhenInUsePermission:
          'Allow Mitalivana to record locations of species observations.',
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Allow Mitalivana to attach photos to species records.',
        cameraPermission: 'Allow Mitalivana to take photos of observed species.',
      },
    ],
    [
      'expo-media-library',
      {
        photosPermission: 'Allow Mitalivana to attach photos to species records.',
        savePhotosPermission:
          'Allow Mitalivana to save captured species photos to your Photos library.',
        isAccessMediaLocationEnabled: true,
      },
    ],
    [
      'expo-audio',
      {
        microphonePermission: 'Allow Mitalivana to record sounds of observed species.',
      },
    ],
    'expo-secure-store',
  ],
  assetBundlePatterns: ['**/*'],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    eas: {
      projectId: '5841ea3d-e6a9-42d6-805a-962aa55f68fb',
    },
    // Empty strings rather than undefined so the account screen can say "not
    // configured" instead of offering a button that silently does nothing.
    googleOauth: {
      clientId: GOOGLE_OAUTH_DEVICE_CLIENT_ID ?? '',
      clientSecret: GOOGLE_OAUTH_DEVICE_CLIENT_SECRET ?? '',
    },
    // Same empty-string convention: no client id → the sign-in button says
    // "not configured".
    orcid: {
      clientId: ORCID_CLIENT_ID ?? '',
      redirectUri: ORCID_REDIRECT_URI ?? '',
      base: ORCID_BASE ?? 'https://orcid.org',
    },
  },
};

export default config;
