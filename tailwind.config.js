/** @type {import('tailwindcss').Config} */
export default {
  content: ['./site/patron/src/**/*.{jsx,js}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0f',
        'bg-panel': '#0f0f18',
        'bg-card': '#14142a',
        border: '#1e1e3a',
        accent: '#f59e0b',
        'accent-dim': 'rgba(245, 158, 11, 0.12)',
        deep: '#a78bfa',
        'deep-dim': 'rgba(167, 139, 250, 0.15)',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
