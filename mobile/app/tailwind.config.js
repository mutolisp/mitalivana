/** @type {import('tailwindcss').Config} */
const { platformSelect } = require('nativewind/theme');

const { fontSize, colors, borderRadius } = require('./theme.tokens.js');

module.exports = {
  content: [
    './app/**/*.{js,jsx,ts,tsx}',
    './components/**/*.{js,jsx,ts,tsx}',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  presets: [require('nativewind/preset')],
  darkMode: 'class',
  theme: {
    fontSize,
    extend: {
      colors,
      // Scientific names (<ScientificName>). RN does not switch to an italic
      // file for `fontStyle: 'italic'`, so each style is its own family,
      // loaded in DBProvider.
      borderRadius,
      fontFamily: {
        // NativeWind's preset maps Android to "mono", which is not an Android
        // family, so font-mono fell back to the proportional system font.
        mono: platformSelect({ android: 'monospace', ios: "'Courier New'" }),
        latin: ['SourceSerif4_400Regular_Italic'],
        'latin-upright': ['SourceSerif4_400Regular'],
        'latin-semibold': ['SourceSerif4_600SemiBold_Italic'],
        'latin-semibold-upright': ['SourceSerif4_600SemiBold'],
      },
    },
  },
  plugins: [],
};
