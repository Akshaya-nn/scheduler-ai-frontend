import { Fragment, useEffect } from 'react';
import {
  closeScheduleFullView,
  readScheduleFullViewPayload,
  type ScheduleFullViewPayload,
  type ScheduleGridPayload,
} from './schedule-full-view';

function getSeatSlot(cell: unknown, slot: 0 | 1): string {
  if (cell == null || typeof cell !== 'object') {
    return '(empty)';
  }
  const o = cell as Record<string, { fullName?: string } | undefined>;
  const s = o[String(slot)];
  const name = s?.fullName;
  if (typeof name === 'string' && name.trim().length > 0) {
    return name.trim();
  }
  return '(empty)';
}

function scheduleRotationColumnCount(schedule: ScheduleGridPayload): number {
  const rows = schedule.seats ?? [];
  const widest = rows.reduce((max, row) => Math.max(max, row?.length ?? 0), 0);
  const n = Math.max(schedule.colCount ?? 0, widest);
  return n > 0 ? n : 1;
}

function scheduleRowDisplayOrder(schedule: ScheduleGridPayload): number[] {
  const rows = schedule.rowData ?? [];
  const seatRows = schedule.seats ?? [];
  if (rows.length === 0 && seatRows.length > 0) {
    return seatRows.map((_, i) => i);
  }

  const primaryOrder: string[] = [];
  const byPrimary = new Map<string, number[]>();
  const fallbackPrimaryKey = (index: number) => `__row_${index}`;

  for (let i = 0; i < rows.length; i += 1) {
    const id = rows[i]?.id ?? '';
    const copyMatch = id.match(/^(.*)::__copy_\d+(?:_\d+)?$/i);
    const primaryKey = copyMatch ? copyMatch[1] : id || fallbackPrimaryKey(i);
    if (!byPrimary.has(primaryKey)) {
      byPrimary.set(primaryKey, []);
      primaryOrder.push(primaryKey);
    }
    byPrimary.get(primaryKey)!.push(i);
  }

  const out: number[] = [];
  for (const key of primaryOrder) {
    const indices = byPrimary.get(key) ?? [];
    const primary = indices.filter((idx) => !/::__copy_\d+(?:_\d+)?$/i.test(rows[idx]?.id ?? ''));
    const copies = indices.filter((idx) => /::__copy_\d+(?:_\d+)?$/i.test(rows[idx]?.id ?? ''));
    out.push(...primary, ...copies);
  }
  if (out.length === 0 && seatRows.length > 0) {
    return seatRows.map((_, i) => i);
  }
  return out;
}

function ScheduleTable({ schedule }: { schedule: ScheduleGridPayload }) {
  const rotationCols = scheduleRotationColumnCount(schedule);
  const orderedRows = scheduleRowDisplayOrder(schedule);

  return (
    <table className="schedule-table">
      <thead>
        <tr>
          <th>Module</th>
          {Array.from({ length: rotationCols }, (_, colIndex) => (
            <th key={colIndex}>Rotation {colIndex + 1}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {orderedRows.map((rowIndex) => {
          const row = schedule.seats[rowIndex] ?? [];
          return (
            <Fragment key={rowIndex}>
              <tr className="student-row student-row-primary">
                <th className="module-col" rowSpan={2}>
                  {schedule.rowData?.[rowIndex]?.moduleName ?? `Module ${rowIndex + 1}`}
                </th>
                {Array.from({ length: rotationCols }, (_, colIndex) => {
                  const cell = row[colIndex];
                  return <td key={`p-${rowIndex}-${colIndex}`}>{getSeatSlot(cell, 0)}</td>;
                })}
              </tr>
              <tr className="student-row student-row-secondary">
                {Array.from({ length: rotationCols }, (_, colIndex) => {
                  const cell = row[colIndex];
                  return <td key={`s-${rowIndex}-${colIndex}`}>{getSeatSlot(cell, 1)}</td>;
                })}
              </tr>
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

type ScheduleFullPageProps = {
  payload: ScheduleFullViewPayload;
  onClose: () => void;
};

export function ScheduleFullPage({ payload, onClose }: ScheduleFullPageProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = payload.title?.trim() || 'Schedule overview';

  return (
    <main className="schedule-full-page">
      <div className="schedule-max-shell">
        <header className="schedule-max-header">
          <h1 className="schedule-max-title">{title}</h1>
          <button
            type="button"
            className="schedule-max-close btn btn-outline"
            aria-label="Back to chat"
            onClick={onClose}
          >
            <span className="schedule-max-close-long" aria-hidden>
              Back to chat
            </span>
            <span className="schedule-max-close-short" aria-hidden>
              Back
            </span>
          </button>
        </header>
        <div className="schedule-max-body">
          <div className="schedule-table-wrap schedule-max-modal-table schedule-table-wrap--scroll">
            <ScheduleTable schedule={payload.schedule} />
          </div>
        </div>
      </div>
    </main>
  );
}

export function ScheduleFullPageRoute({ onClose }: { onClose: () => void }) {
  const payload = readScheduleFullViewPayload();
  if (!payload) {
    closeScheduleFullView();
    return (
      <main className="schedule-full-page schedule-full-page--empty">
        <p className="schedule-full-page-fallback">No schedule to display.</p>
        <button type="button" className="btn btn-outline" onClick={onClose}>
          Back to chat
        </button>
      </main>
    );
  }
  return <ScheduleFullPage payload={payload} onClose={onClose} />;
}
