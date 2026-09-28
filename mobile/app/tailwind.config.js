/** @type {import('tailwindcss').Config} */

// Warm neutral scale sampled from the app icon and splash colours.
// Replaces Tailwind's cool gray everywhere in one step.
const warm = {
  50: '#F6EFE2',  // paper
  100: '#EDE3D2',
  200: '#E4D7C1', // line
  300: '#CDBDA3',
  400: '#A8977F', // disabled / decorative only (2.5:1 on paper)
  500: '#6F5F52', // ink-3
  600: '#5A4B3D', // ink-2
  700: '#4A3D31',
  800: '#372C23',
  900: '#2B2119', // ink; dark-mode card
  950: '#1F1814', // dark-mode paper (= splash dark)
};

// Moss: the single interactive / recording colour.
const moss = {
  50: '#F2F6EE',
  100: '#E6EEDF', // accent-tint
  200: '#CADBC1',
  300: '#A9CBA9',
  400: '#7FB38A', // accent in dark mode
  500: '#4F8A5B',
  600: '#2F6B3E', // accent
  700: '#265833', // pressed
  800: '#1E4628',
  900: '#17361F',
  950: '#0E2213',
};

module.exports = {
  content: [
    './app/**/*.{js,jsx,ts,tsx}',
    './components/**/*.{js,jsx,ts,tsx}',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  presets: [require('nativewind/preset')],
  darkMode: 'class',
  theme: {
    fontSize: {
      'xxs': ['var(--ts-xxs, 10px)', { lineHeight: 'var(--lh-xxs, 14px)' }],
      'xs':  ['var(--ts-xs, 12px)',  { lineHeight: 'var(--lh-xs, 16px)' }],
      'sm':  ['var(--ts-sm, 14px)',  { lineHeight: 'var(--lh-sm, 20px)' }],
      'base':['var(--ts-base, 16px)',{ lineHeight: 'var(--lh-base, 24px)' }],
      'lg':  ['var(--ts-lg, 18px)',  { lineHeight: 'var(--lh-lg, 28px)' }],
      'xl':  ['var(--ts-xl, 20px)',  { lineHeight: 'var(--lh-xl, 28px)' }],
      '2xl': ['var(--ts-2xl, 24px)', { lineHeight: 'var(--lh-2xl, 32px)' }],
      '3xl': ['var(--ts-3xl, 30px)', { lineHeight: 'var(--lh-3xl, 36px)' }],
    },
    extend: {
      colors: {
        gray: warm,
        emerald: moss,
        accent: { ...moss, DEFAULT: moss[600], tint: moss[100] },
        paper: { DEFAULT: warm[50], dark: warm[950] },
        card: { DEFAULT: '#FFFBF3', dark: warm[900] },
        line: { DEFAULT: warm[200], dark: warm[700] },
        ink: { DEFAULT: warm[900], 2: warm[600], 3: warm[500] },
        cupule: '#6B5433',
        acorn: { DEFAULT: '#E0A04A', deep: '#97561A', pressed: '#C98A36', tint: '#F3E4CB' },
        alert: { DEFAULT: '#A8321F', tint: '#F7E3DC', dark: '#E8876F', 'dark-tint': '#4A2A22' },
      },
    },
  },
  plugins: [],
};
