import { isScheduleFullViewPath } from './schedule-full-view';

const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

/** Session ids issued by the AI scheduler (UUID v4). */
const SESSION_ID_PATH_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SESSION_URL_SYNC_EVENT = 'scheduler-ai:session-url-sync';

function normalizePathname(pathname: string): string {
  const stripped = pathname.replace(/\/$/, '');
  return stripped === '' ? '/' : stripped;
}

function pathSegmentAfterBase(): string {
  const path = normalizePathname(window.location.pathname);
  const base = normalizePathname(BASE);
  let segment = path;
  if (base !== '/' && path.startsWith(base)) {
    segment = normalizePathname(path.slice(base.length) || '/');
  }
  return segment.replace(/^\//, '');
}

export function isSessionIdPath(value: string): boolean {
  return SESSION_ID_PATH_RE.test(value.trim());
}

/** Reads session id from `/{sessionId}` (not schedule-full or other reserved paths). */
export function readSessionIdFromPath(): string | null {
  if (isScheduleFullViewPath()) {
    return null;
  }
  const segment = pathSegmentAfterBase();
  if (!segment || segment.includes('/') || segment === 'schedule-full') {
    return null;
  }
  return isSessionIdPath(segment) ? segment : null;
}

export function buildSessionShareUrl(sessionId: string): string {
  const base = BASE || '';
  return `${window.location.origin}${base}/${sessionId}`.replace(/([^:]\/)\/+/g, '$1');
}

function notifySessionUrlSync(): void {
  window.dispatchEvent(new Event(SESSION_URL_SYNC_EVENT));
}

/** Updates the browser URL to `/{sessionId}` for shareable chat links. */
export function syncSessionIdToUrl(sessionId: string): void {
  if (!isSessionIdPath(sessionId) || isScheduleFullViewPath()) {
    return;
  }
  const base = BASE || '';
  const target = `${base}/${sessionId}`.replace(/\/+/g, '/');
  const current = normalizePathname(window.location.pathname);
  if (current !== normalizePathname(target)) {
    window.history.replaceState({ sessionShare: sessionId }, '', target);
    notifySessionUrlSync();
  }
}

export function clearSessionIdFromUrl(): void {
  if (isScheduleFullViewPath()) {
    return;
  }
  const home = BASE || '/';
  window.history.replaceState({}, '', home);
  notifySessionUrlSync();
}
