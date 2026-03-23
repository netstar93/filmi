export const BREAKPOINTS = {
  phone: 0,
  tablet: 768,
  largeTablet: 1024,
  tv: 1440,
} as const;

export const REMOVAL_IGNORE_DURATION = 10000;
export const CACHE_DURATION = 5 * 60 * 1000;
export const TRAKT_SYNC_COOLDOWN = 0;
export const SIMKL_SYNC_COOLDOWN = 0;
export const TRAKT_RECONCILE_COOLDOWN = 0;

// Match NuvioTV: 60-day window (was 30), 300 max items (was 30), 24 max next-up lookups
export const CW_DEFAULT_DAYS_CAP = 60;
export const CW_MAX_RECENT_PROGRESS_ITEMS = 300;
export const CW_MAX_NEXT_UP_LOOKUPS = 24;
export const CW_MAX_DISPLAY_ITEMS = 30;
export const CW_NEXT_UP_NEW_SEASON_UNAIRED_WINDOW_DAYS = 7;
export const CW_HISTORY_MAX_PAGES = 5;
export const CW_HISTORY_PAGE_LIMIT = 100;
