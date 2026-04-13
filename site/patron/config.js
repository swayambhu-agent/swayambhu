// Dashboard patron config — edit these values to customize the dashboard.
window.DASHBOARD_CONFIG = {
  // Dashboard API origin.
  apiUrl: "https://api.swayambhu.dev",

  // Timezone for all displayed timestamps (IANA format).
  timezone: "Asia/Kolkata",

  // Locale for date/time formatting.
  locale: "en-IN",

  // Max characters shown before "show more" truncation.
  truncate: {
    jsonString: 800,   // inside JSON viewer (nested string values)
    textBlock: 800,    // standalone text blocks (detail panel, reflections)
  },

  // Heartbeat polling intervals (ms).
  heartbeat: {
    normalMs: 5000,    // default poll interval
    activeMs: 2000,    // when session is active
    hiddenMs: 15000,   // when browser tab is hidden
    safetyMs: 60000,   // per-tab safety net poll (fallback)
  },
};
