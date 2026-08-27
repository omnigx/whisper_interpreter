import {
  DEFAULT_CHINESE_FONT,
  DEFAULT_WESTERN_FONT
} from '@shared/subtitleSync'

export { DEFAULT_CHINESE_FONT, DEFAULT_WESTERN_FONT }

export const CHINESE_FONT_PRESETS = [
  { label: '系统默认', value: DEFAULT_CHINESE_FONT },
  {
    label: '思源宋体',
    value: '"Noto Serif SC", "Source Han Serif SC", "Source Han Serif CN"'
  },
  {
    label: '思源黑体',
    value: '"Noto Sans SC", "Source Han Sans SC", "Source Han Sans CN"'
  }
] as const

/** Western presets: default is pure Latin system chain; others are single faces. */
export const WESTERN_FONT_PRESETS = [
  { label: '系统默认', value: DEFAULT_WESTERN_FONT },
  { label: 'Arial', value: 'Arial' },
  { label: 'Times New Roman', value: '"Times New Roman"' },
  { label: 'Calibri', value: 'Calibri' }
] as const

/**
 * Western first (Latin glyphs), then Chinese stack, then global sans-serif.
 * Western values must stay free of CJK-capable generics so chineseFont can win.
 */
export function buildContentFontFamily(westernFont: string, chineseFont: string): string {
  return `${westernFont}, ${chineseFont}, sans-serif`
}
