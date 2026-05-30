type SeatCell = { 0: { id: string; fullName: string }; 1: { id: string; fullName: string } };

export type ScheduleGridPayload = {
  seats: SeatCell[][];
  rowData: Array<{ id?: string; moduleName: string }>;
  rowCount: number;
  colCount: number;
  warnings: string[];
};

const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

/** Path-based full schedule view (no hash in the URL). */
export const SCHEDULE_FULL_VIEW_PATH = `${BASE}/schedule-full`.replace(/\/+/g, '/');

const STORAGE_KEY = 'scheduler-ai:schedule-full-view';

/** Fired after pushState navigation so App can sync without a hash. */
export const SCHEDULE_VIEW_SYNC_EVENT = 'scheduler-ai:schedule-view-sync';

export type ScheduleFullViewPayload = {
  schedule: ScheduleGridPayload;
  title?: string;
};

function normalizePathname(pathname: string): string {
  const stripped = pathname.replace(/\/$/, '');
  return stripped === '' ? '/' : stripped;
}

/** Redirect old hash URLs (e.g. `#/schedule-full`) to the path-based route. */
export function migrateLegacyScheduleFullHash(): void {
  const hash = window.location.hash.replace(/^#/, '').replace(/^\//, '');
  if (hash !== 'schedule-full') {
    return;
  }
  window.history.replaceState(
    { scheduleFullView: true },
    '',
    `${SCHEDULE_FULL_VIEW_PATH}${window.location.search}`,
  );
}

export function isScheduleFullViewPath(): boolean {
  const path = normalizePathname(window.location.pathname);
  const target = normalizePathname(SCHEDULE_FULL_VIEW_PATH);
  return path === target || path.startsWith(`${target}/`);
}

function notifyViewSync(): void {
  window.dispatchEvent(new Event(SCHEDULE_VIEW_SYNC_EVENT));
}

export function readScheduleFullViewPayload(): ScheduleFullViewPayload | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as ScheduleFullViewPayload;
    if (!parsed?.schedule || !Array.isArray(parsed.schedule.seats)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function openScheduleFullView(payload: ScheduleFullViewPayload): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  if (!isScheduleFullViewPath()) {
    window.history.pushState({ scheduleFullView: true }, '', SCHEDULE_FULL_VIEW_PATH);
  }
  notifyViewSync();
}

export function closeScheduleFullView(): void {
  sessionStorage.removeItem(STORAGE_KEY);
  if (!isScheduleFullViewPath()) {
    return;
  }
  /** Always return to the chat app root — avoid history.back() leaving the site or closing the tab. */
  const home = BASE || '/';
  window.history.pushState({}, '', home);
  notifyViewSync();
}
