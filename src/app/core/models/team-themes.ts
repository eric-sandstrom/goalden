/**
 * Hand-picked colour palettes per national team. Used by the theme picker to
 * theme the app in a team's colours. Each entry includes:
 *
 *  - `matchNames`: every name the team might appear under in football-data.org
 *    (the API isn't always consistent — "South Korea" vs "Korea Republic",
 *    "USA" vs "United States", etc.). Lookup is case-insensitive.
 *  - `primary` / `secondary?` / `tertiary`: source colours fed into Material's
 *    DynamicScheme via ThemeService.
 *
 * Pure-white flag stripes are deliberately omitted — Material's HCT algorithm
 * collapses to grayscale on zero-chroma inputs, which looks worse than the
 * variant-derived secondary it would otherwise compute.
 */
export interface TeamThemeOverride {
  readonly matchNames: readonly string[];
  readonly primary: string;
  readonly secondary?: string;
  readonly tertiary: string;
}

export const TEAM_THEME_OVERRIDES: readonly TeamThemeOverride[] = [
  { matchNames: ['Argentina'], primary: '#75AADB', tertiary: '#F6B40E' },
  { matchNames: ['Austria'], primary: '#ED2939', tertiary: '#222222' },
  { matchNames: ['Australia'], primary: '#012169', secondary: '#E1392D', tertiary: '#FFD700' },
  { matchNames: ['Belgium'], primary: '#ED2939', secondary: '#222222', tertiary: '#FAE042' },
  { matchNames: ['Brazil'], primary: '#009C3B', secondary: '#002776', tertiary: '#FFDF00' },
  { matchNames: ['Canada'], primary: '#D52B1E', tertiary: '#1F2A44' },
  { matchNames: ['Switzerland'], primary: '#DA291C', tertiary: '#1F2A44' },
  { matchNames: ['Chile'], primary: '#0033A0', tertiary: '#DA291C' },
  { matchNames: ['Colombia'], primary: '#FCD116', secondary: '#CE1126', tertiary: '#003893' },
  { matchNames: ['Czechia', 'Czech Republic'], primary: '#11457E', tertiary: '#D7141A' },
  { matchNames: ['Germany'], primary: '#DD0000', secondary: '#222222', tertiary: '#FFCE00' },
  { matchNames: ['Denmark'], primary: '#C8102E', tertiary: '#1F2A44' },
  { matchNames: ['England'], primary: '#012169', tertiary: '#CE1124' },
  { matchNames: ['Spain'], primary: '#AA151B', tertiary: '#F1BF00' },
  { matchNames: ['France'], primary: '#002654', tertiary: '#ED2939' },
  { matchNames: ['Croatia'], primary: '#171796', tertiary: '#DC2A2A' },
  { matchNames: ['Italy'], primary: '#008C45', tertiary: '#CD212A' },
  { matchNames: ['Japan'], primary: '#BC002D', tertiary: '#1F2A44' },
  {
    matchNames: ['South Korea', 'Korea Republic'],
    primary: '#003478',
    secondary: '#222222',
    tertiary: '#C60C30',
  },
  { matchNames: ['Morocco'], primary: '#C1272D', tertiary: '#006233' },
  { matchNames: ['Mexico'], primary: '#006847', tertiary: '#CE1126' },
  { matchNames: ['Nigeria'], primary: '#008751', tertiary: '#FFFFFF' },
  { matchNames: ['Netherlands'], primary: '#FF6900', tertiary: '#21468B' },
  { matchNames: ['Norway'], primary: '#BA0C2F', tertiary: '#00205B' },
  { matchNames: ['Poland'], primary: '#DC143C', tertiary: '#1F2A44' },
  { matchNames: ['Portugal'], primary: '#006600', secondary: '#FFCC00', tertiary: '#FF0000' },
  { matchNames: ['Sweden'], primary: '#006AA7', tertiary: '#FECC00' },
  { matchNames: ['Senegal'], primary: '#00853F', secondary: '#E12036', tertiary: '#FDEF42' },
  { matchNames: ['Ukraine'], primary: '#0057B7', tertiary: '#FFDD00' },
  {
    matchNames: ['USA', 'United States', 'United States of America'],
    primary: '#3C3B6E',
    tertiary: '#B22234',
  },
  { matchNames: ['Uruguay'], primary: '#0038A8', tertiary: '#FCD116' },
];

/** Case-insensitive lookup. Returns the first override whose matchNames
 *  contains the given team name, or null if none match. */
export function findThemeOverride(teamName: string): TeamThemeOverride | null {
  const needle = teamName.trim().toLowerCase();
  for (const entry of TEAM_THEME_OVERRIDES) {
    if (entry.matchNames.some((n) => n.toLowerCase() === needle)) return entry;
  }
  return null;
}
