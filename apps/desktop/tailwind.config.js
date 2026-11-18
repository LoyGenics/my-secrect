/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'ms-text': 'var(--ms-color-text-primary)',
        'ms-muted': 'var(--ms-color-text-muted)',
        'ms-link': 'var(--ms-color-text-link)',
        'ms-line': 'var(--ms-color-border-default)',
        'ms-surface': 'var(--ms-color-bg-surface)',
        'ms-surface2': 'var(--ms-color-bg-surface2)',
        'ms-sunken': 'var(--ms-color-bg-sunken)',
        'ms-brand-bg': 'var(--ms-color-brand-soft)',
        'ms-danger-text': 'var(--ms-color-danger-soft-text)',
        'ms-danger-bg': 'var(--ms-color-danger-soft)',
        'ms-danger-line': 'var(--ms-color-danger-border)',
        'ms-warn-text': 'var(--ms-color-warning-text)',
        'ms-warn-bg': 'var(--ms-color-warning-soft)',
        'ms-warn-line': 'var(--ms-color-warning)',
        'ms-ok-text': 'var(--ms-color-success-text)',
        'ms-ok-bg': 'var(--ms-color-success-soft)',
        'ms-ok-line': 'var(--ms-color-success)',
      },
      },
  },
  plugins: [],
};
