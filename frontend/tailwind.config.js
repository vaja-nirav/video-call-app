/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        dark: {
          bg: '#0A0A0E',       // Pure charcoal backdrop
          card: '#12121A',     // Card/overlay color
          border: '#1E1E2C',   // Subtle borders
          hover: '#1B1B28',    // Active list elements
          accent: '#6366F1',   // Deep Indigo
          accentHover: '#4F46E5',
        }
      },
      fontFamily: {
        sans: ['Outfit', 'Inter', 'system-ui', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
