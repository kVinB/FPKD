/** @type {import('tailwindcss').Config} */
export default {
  content: ['./web/index.html', './web/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        slatebg: '#f4f6f8',
        ink: '#17212b',
        teal: {
          600: '#0f766e',
          700: '#115e59',
          50: '#eefbf8',
        },
      },
    },
  },
  plugins: [],
};
