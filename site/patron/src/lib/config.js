const CFG = window.DASHBOARD_CONFIG || {};
export const TIMEZONE = CFG.timezone || undefined; // undefined = browser default
export const LOCALE = CFG.locale || undefined;
export const API_URL = CFG.apiUrl || (
  location.hostname === 'localhost' || location.protocol === 'file:'
    ? 'http://localhost:8790'
    : 'https://swayambhu-dashboard-api.swayambhu1.workers.dev'
);
export const TRUNCATE_JSON = CFG.truncate?.jsonString || 800;
export const TRUNCATE_TEXT = CFG.truncate?.textBlock || 800;
const HB = CFG.heartbeat || {};
export const HB_NORMAL = HB.normalMs || 5000;
export const HB_ACTIVE = HB.activeMs || 2000;
export const HB_HIDDEN = HB.hiddenMs || 15000;
export const HB_SAFETY = HB.safetyMs || 60000;
