/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter"', '"DM Sans"', 'system-ui', 'sans-serif'],
        serif: ['"Source Serif 4"', 'Georgia', 'serif'],
        geist: ['"Geist"', '"Inter"', 'system-ui', 'sans-serif'],
        'mono-ed': ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        navy: { DEFAULT: '#38A638', light: '#43B843', mid: '#2F8F2F' },
        gold: { DEFAULT: '#62B462', light: '#EFFCEF' },
        teal: { DEFAULT: '#38A638' },
        offwhite: '#FAFAFA',
        cream: '#F5F5F5',
        textdark: '#262626',
        textmid: '#737373',
        textlight: '#A3A3A3',
        darkbg: '#05050A',
        darkcard: '#0D0E15',
        neonpurple: '#38A638',
        neoncian: '#62B462',
        neonpink: '#2F8F2F',
        'ed-bg': '#ffffff',
        'ed-surface': '#ffffff',
        'ed-ink': '#262626',
        'ed-ink2': '#737373',
        'ed-ink3': '#a3a3a3',
        'ed-line': '#ebebeb',
        'ed-accent': '#38a638',
        'ed-accent-soft': '#effcef',
        'ed-green': '#38a638',
        'ed-gold': '#62b462',
        'ed-rust': '#ef4444',
        'ed-gray': '#a3a3a3',
      },
      borderRadius: {
        'xl': '12px',
        '2xl': '16px',
        '3xl': '20px',
      },
      boxShadow: {
        'card': '0 4px 24px rgba(0, 0, 0, 0.04)',
        'card-hover': '0 8px 32px rgba(0, 0, 0, 0.06)',
        'gold': '0 4px 20px rgba(56, 166, 56, 0.28)',
        'neon': '0 4px 24px rgba(56, 166, 56, 0.28)',
        'neon-hover': '0 8px 32px rgba(56, 166, 56, 0.32)',
        'nav': '0 1px 4px rgba(0, 0, 0, 0.03)',
        'pill': '0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 1px rgba(0, 0, 0, 0.04)',
      },
      keyframes: {
        'fade-in-up': {
          // End state MUST be `transform: 'none'`, NOT 'translateY(0)'. A non-none
          // transform on an ancestor (especially <main>, which uses this animation)
          // creates a containing block for fixed-positioned descendants — modals
          // would open relative to that ancestor's bounding box instead of the viewport.
          '0%': { opacity: 0, transform: 'translateY(12px)' },
          '100%': { opacity: 1, transform: 'none' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(56, 166, 56, 0.4)' },
          '50%': { boxShadow: '0 0 0 4px rgba(56, 166, 56, 0.1)' },
        }
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.4s ease-out forwards',
        'pulse-glow': 'pulse-glow 2s infinite',
      }
    }
  },
  plugins: []
};
