export const colors = {
  bg: '#0E0D11',
  surface: '#141217',
  border: '#34303A',
  primary: '#7028C9',
  primaryBright: '#A855F7',
  text: '#FFFFFF',
  textSecondary: '#D5D7DC',
  textMuted: '#A9A4AF',
  success: '#32D583',
  danger: '#F97066',
};
export const spacing = (n: number) => n * 4;
export const radius = { card: 16, button: 12, pill: 999 };
// League Spartan is set in UPPERCASE only; sentence-case text uses the system font.
export const fonts = {
  heading: 'LeagueSpartan_800ExtraBold',
  headingBlack: 'LeagueSpartan_900Black',
  body: undefined as string | undefined, // system body font
};

export type Mode = 'light' | 'dark';

export interface Theme {
  bg: [string, string, string]; // screen gradient, top to bottom
  text: string;
  muted: string;
  faint: string;
  sheet: string; // cards
  sheetBorder: string;
  chip: string; // unselected chips, tiles and small buttons
  soft: string; // selected tiles and extras
  field: string;
  line: string;
  accent: string; // small labels and links
  primary: string; // buttons, selected chips, section numbers
  footer: string;
  error: string;
  success: string;
  statusBar: 'light' | 'dark';
}

// Checkout + member screens. Both modes use the website's purple; dark (the website look) is the default.
export const themes: Record<Mode, Theme> = {
  dark: {
    bg: [colors.bg, '#110E16', '#1A1030'], text: colors.text, muted: colors.textMuted, faint: '#8E8894',
    sheet: colors.surface, sheetBorder: colors.border, chip: '#1E1B24', soft: 'rgba(168,85,247,0.16)', field: '#1B1920', line: colors.border,
    accent: colors.primaryBright, primary: colors.primary, footer: colors.surface,
    error: colors.danger, success: colors.success, statusBar: 'light',
  },
  light: {
    bg: ['#FBFAFD', '#F5F0FA', '#ECE3F7'], text: '#16121C', muted: '#6B6475', faint: '#958EA0',
    sheet: '#FFFFFF', sheetBorder: '#ECE6F3', chip: '#F3EFF8', soft: '#EFE5FC', field: '#F8F5FB', line: '#E3DAEE',
    accent: colors.primary, primary: colors.primary, footer: '#FFFFFF',
    error: '#B42318', success: '#067647', statusBar: 'dark',
  },
};

// The website's badge gradient; white text sits on it in both modes.
export const brandGradient = ['#7028C9', '#4C1D95'] as const;
