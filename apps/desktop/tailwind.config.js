/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        slate: {
          850: '#151d27',
          900: '#0f172a',
          950: '#0B0F14',
        },
        accent: {
          DEFAULT: '#6366f1',
          hover: '#4f46e5',
          soft: '#312e81',
        },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
