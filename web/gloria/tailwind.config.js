/**
 * Same design tokens as the mobile app (mobile/app/theme.tokens.js), so the
 * NativeWind class strings in shared components render with the same colours,
 * type scale and radii. Dark mode follows the system (`media`), as the web
 * shim of `useColorScheme` does (src/host/nativewind.ts).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fontSize, colors, borderRadius } = require('../../mobile/app/theme.tokens.js');

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    // Shared mobile UI and GLORIA screens (same list as scripts/gen-icons.mjs).
    '../../mobile/app/src/components/**/*.tsx',
    '../../mobile/app/src/lib/**/*.tsx',
    '../../mobile/app/src/modules/gloria/**/*.tsx',
    '../../mobile/app/app/gloria/**/*.tsx',
  ],
  darkMode: 'media',
  theme: {
    fontSize,
    extend: {
      colors,
      borderRadius,
      fontFamily: {
        latin: ['SourceSerif4_400Regular_Italic', 'Georgia', 'serif'],
        'latin-upright': ['SourceSerif4_400Regular', 'Georgia', 'serif'],
        'latin-semibold': ['SourceSerif4_600SemiBold_Italic', 'Georgia', 'serif'],
        'latin-semibold-upright': ['SourceSerif4_600SemiBold', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
};
