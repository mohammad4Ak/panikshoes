import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Shared sporty palette across storefront and dashboard.
        night: 'rgb(var(--theme-ink, 20 33 28) / <alpha-value>)', // بخشهای تیره، متن اصلی
        mist: 'rgb(var(--theme-muted, 105 116 110) / <alpha-value>)', // متن ثانویه
        paper: '#FFFFFF', // کارت و سطوح
        fog: 'rgb(var(--theme-page, 244 246 248) / <alpha-value>)', // پسزمینه صفحه
        line: 'rgb(var(--theme-line, 226 232 227) / <alpha-value>)', // خطوط و بوردرها
        lime: { DEFAULT: 'rgb(var(--theme-accent, 215 247 106) / <alpha-value>)' },
        brand: {
          DEFAULT: 'rgb(var(--theme-brand, 18 102 74) / <alpha-value>)',
          strong: 'rgb(var(--theme-brand-strong, 11 79 56) / <alpha-value>)',
          soft: 'rgb(var(--theme-brand-soft, 234 243 238) / <alpha-value>)',
        },
      },
      fontFamily: {
        display: ['var(--font-vazir)', 'sans-serif'],
        body: ['var(--font-vazir)', 'sans-serif'],
        mono: ['var(--font-jetbrains)', 'monospace'],
      },
    },
  },
}
export default config
