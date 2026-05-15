/**
 * Brand tokens — single source of truth for color, typography, radii.
 *
 * Web (Tailwind v4 `@theme` block in src/styles/app.css) and React Email
 * templates (inline styles) both consume this module so that the digest
 * email and the marketing surfaces are visually identical.
 *
 * Do not introduce per-surface overrides — change values here.
 */

export const colors = {
  ink: '#0a0a0f',
  inkSoft: '#15151c',
  inkLine: '#1f1f2a',
  paper: '#fafaf7',
  paperWarm: '#f4f3ee',
  text: '#1a1a22',
  textMuted: '#5a5a6a',
  accent: '#d9ff3a',
  accentWarm: '#ffd60a',
  coral: '#ff5b3a',
} as const

export type ColorToken = keyof typeof colors

export const fonts = {
  sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const

export const fontWeights = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
} as const

export const radii = {
  sm: '4px',
  md: '12px',
  card: '16px',
  cardLg: '20px',
  pill: '999px',
} as const

export const shadows = {
  digestCard: '0 40px 80px rgba(0, 0, 0, 0.4)',
} as const

/**
 * Shape of a single digest tag (launch / market / voc).
 * Used in both the marketing digest preview and the real email template.
 */
export const digestTags = {
  launch: { bg: 'rgba(217, 255, 58, 0.15)', fg: colors.accent },
  pricing: { bg: 'rgba(255, 91, 58, 0.15)', fg: colors.coral },
  feature: { bg: 'rgba(120, 180, 255, 0.15)', fg: '#78b4ff' },
  positioning: { bg: 'rgba(255, 214, 10, 0.15)', fg: colors.accentWarm },
  noise: { bg: 'rgba(90, 90, 106, 0.15)', fg: colors.textMuted },
} as const

export type DigestTag = keyof typeof digestTags

export const tokens = {
  colors,
  fonts,
  fontWeights,
  radii,
  shadows,
  digestTags,
} as const

export type Tokens = typeof tokens
