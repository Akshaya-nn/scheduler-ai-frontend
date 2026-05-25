import { FormEvent, Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ScheduleFullPageRoute } from './ScheduleFullPage';
import {
  closeScheduleFullView,
  isScheduleFullViewPath,
  migrateLegacyScheduleFullHash,
  openScheduleFullView,
  SCHEDULE_VIEW_SYNC_EVENT,
} from './schedule-full-view';

function toggleId(id: string, list: string[], setter: (next: string[]) => void) {
  if (list.includes(id)) {
    setter(list.filter((item) => item !== id));
    return;
  }
  setter([...list, id]);
}

function toggleAllIds(ids: string[], list: string[], setter: (next: string[]) => void) {
  if (ids.length === 0) {
    setter([]);
    return;
  }
  const allSelected = ids.every((id) => list.includes(id));
  setter(allSelected ? [] : [...ids]);
}

type Student = { id: string; fullName: string };
type ModuleItem = { id: string; name: string };
type ScheduleTypeItem = { id: string; name: string; type: string };
type SeatCell = { 0: { id: string; fullName: string }; 1: { id: string; fullName: string } };

/** Public API `step` ” what the client should show next (matches server `SelectionStep`). */
type ResponseStep =
  | 'schedule_types'
  | 'modules'
  | 'students'
  | 'rotation_range'
  | 'rotation_count'
  | 'assistantMessage'
  | 'rotation_capacity'
  | 'pairing'
  | 'schedule'
  | 'completed'
  | 'generic';

type ApiResponse = {
  statusCode?: number;
  success?: boolean;
  sessionId: string;
  step: ResponseStep;
  assistantMessage: string;
  rotationRangeMax?: number;
  students: Student[];
  modules: ModuleItem[];
  scheduleTypes?: ScheduleTypeItem[];
  selectedScheduleType?: { type: string; name: string } | null;
  selectedStudents?: Student[];
  selectedModules?: ModuleItem[];
  schedule?: {
    seats: SeatCell[][];
    rowData: Array<{ id?: string; moduleName: string }>;
    rowCount: number;
    colCount: number;
    warnings: string[];
  } | null;
  config?: {
    startRotation?: number;
    endRotation?: number;
    pairStudent?: boolean;
    restrictCrossScheduleModuleRepeat?: boolean;
  };
};

/** Merge a shaped server payload into full client state (server omits unchanged lists). */
function mergePartialAiResponse(prev: ApiResponse | null, incoming: Record<string, unknown>): ApiResponse {
  const i = incoming as Partial<ApiResponse>;
  const students = i.students !== undefined ? i.students : (prev?.students ?? []);
  const step = (i.step ?? prev?.step ?? 'generic') as ApiResponse['step'];
  let modules = i.modules !== undefined ? i.modules : (prev?.modules ?? []);
  /**
   * Schedule-type-only turns omit `modules`; without this, merged state keeps the old catalog and
   * the UI shows the module checklist while the assistant asks for a schedule type.
   */
  if (
    i.modules === undefined &&
    i.scheduleTypes !== undefined &&
    Array.isArray(i.scheduleTypes) &&
    i.scheduleTypes.length > 0 &&
    step === 'schedule_types'
  ) {
    modules = [];
  }
  const scheduleTypeListActive = step === 'schedule_types';
  const incomingHasSchedule = i.schedule !== undefined && i.schedule !== null;
  const selectedModules = i.selectedModules !== undefined
    ? i.selectedModules
    : scheduleTypeListActive
      ? []
      : incomingHasSchedule && (prev?.selectedModules?.length ?? 0) > 0
        ? prev!.selectedModules!
        : (prev?.selectedModules ?? []);
  const selectedStudents =
    i.selectedStudents !== undefined
      ? i.selectedStudents
      : incomingHasSchedule && (prev?.selectedStudents?.length ?? 0) > 0
        ? prev!.selectedStudents!
        : (prev?.selectedStudents ?? students);
  return {
    statusCode: i.statusCode ?? prev?.statusCode,
    success: i.success ?? prev?.success,
    sessionId: (i.sessionId ?? prev?.sessionId ?? '') as string,
    step: (i.step ?? prev?.step ?? 'generic') as ApiResponse['step'],
    assistantMessage: (i.assistantMessage ?? prev?.assistantMessage ?? '') as string,
    rotationRangeMax:
      i.rotationRangeMax !== undefined ? i.rotationRangeMax : undefined,
    students,
    modules,
    scheduleTypes: i.scheduleTypes !== undefined ? i.scheduleTypes : prev?.scheduleTypes,
    selectedScheduleType:
      i.selectedScheduleType !== undefined ? i.selectedScheduleType : prev?.selectedScheduleType,
    selectedStudents,
    selectedModules,
    schedule: i.schedule !== undefined ? i.schedule : (prev?.schedule ?? null),
    config: i.config !== undefined ? i.config : prev?.config,
  };
}

const apiBase = import.meta.env.VITE_AI_API_BASE ?? 'http://localhost:8080/v2';

type ChatPicker =
  | {
      kind: 'schedule_types';
      frozen: boolean;
      intro: string[];
      options: ScheduleTypeItem[];
      selectedId?: string;
    }
  | {
      kind: 'modules';
      frozen: boolean;
      intro: string[];
      modules: ModuleItem[];
      selectedIds: string[];
      copyEachModule: boolean;
      copyModuleCount: string;
      contentLabel: string;
    }
  | {
      kind: 'students';
      frozen: boolean;
      intro: string[];
      students: Student[];
      selectedIds: string[];
    }
  | {
      kind: 'rotation_range';
      frozen: boolean;
      intro: string;
      start: string;
      end: string;
      maxEnd: number;
    };

type ChatMessage = {
  id: string;
  role: 'assistant' | 'user';
  /** Plain assistant line or caption under a user list */
  text?: string;
  /** User selection title, e.g. "Selected students (10)" */
  heading?: string;
  /** Numbered list lines */
  items?: string[];
  isError?: boolean;
  /** Preserve markdown-style tables without collapsing whitespace */
  preformatted?: boolean;
  /** Frozen schedule grid shown inside the chat bubble */
  schedule?: NonNullable<ApiResponse['schedule']>;
  /** Show Yes/No save footer under the grid in this bubble */
  showSavePrompt?: boolean;
  /** Inline checklist / picker (single assistant bubble ” no duplicate text above) */
  picker?: ChatPicker;
};

type ChatMode = 'awaiting_intent' | 'awaiting_class_id' | 'active';

function isRotationalIntent(message: string): boolean {
  const value = message.toLowerCase();
  const keywords = ['rotation', 'rotational', 'schedule', 'scheduler', 'module', 'students', 'class'];
  return keywords.some((keyword) => value.includes(keyword));
}

/** Detect when user wants to start a brand new schedule after one is already generated. */
function isCreateNewScheduleIntent(message: string): boolean {
  const value = message.toLowerCase().trim();
  if (!value) return false;
  const hasScheduleWord = /\b(schedule|rotational|rotation)\b/.test(value);
  const hasFreshness = /\b(new|another|next|fresh|one\s+more|additional|again)\b/.test(value);
  const explicitCreate =
    /^\s*(create|generate|make|build|start|do)\b[^\n]*\b(another|new|fresh|next|additional|one\s+more|again)\b/.test(
      value,
    );
  if (explicitCreate) {
    return true;
  }
  return hasScheduleWord && hasFreshness;
}

/** Extract first 24-char Mongo ObjectId from a free-text message. */
function extractClassIdFromMessage(message: string): string | null {
  const match = message.match(/\b[a-fA-F0-9]{24}\b/);
  return match ? match[0] : null;
}

function nextMessageId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Remove "1. Name" style lines so the list is not duplicated in chat when the picker shows it. */
function stripNumberedListLines(text: string): string {
  return text
    .split(/\n/)
    .filter((line) => !/^\s*\d+\s*[\.\)]\s*\S/.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Intro paragraphs for the unified student picker (no numbered names). */
function studentPickerIntroText(assistantMessage: string): string[] {
  const stripped = stripNumberedListLines((assistantMessage ?? '').trim());
  if (!stripped) {
    return ['Choose who should be on this rotation, then confirm. You can also type names or numbers in the chat.'];
  }
  return stripped
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** True when the assistant message is asking the user to pick a schedule type. */
function isScheduleTypePrompt(assistantMessage: string): boolean {
  const raw = (assistantMessage ?? '').trim();
  const hasNumberedTypes = /^\s*\d+\s*[\.\)]\s*\S/m.test(raw);
  const asksScheduleTypes =
    /\b(module\s*type|schedule\s*types?|schedule\s+type|content\s*type|kind\s+of\s+rotational\s+schedule)\b/i.test(
      raw,
    ) ||
    /\bchoose a \*\*schedule type\*\*/i.test(raw) ||
    /\bpick\s+one\s+of\s+these\s+schedule\s+types\b/i.test(raw) ||
    /\bselect\s+the\s+schedule\s+type\s+you\s+need\s+for\s+this\s+update\b/i.test(raw);
  return asksScheduleTypes && hasNumberedTypes;
}

/** True when schedule-type response includes an error/retry explanation. */
function isScheduleTypeRetryMessage(assistantMessage: string): boolean {
  const raw = (assistantMessage ?? '').trim();
  return (
    /\b(could not match|that did not match|no active items available|please choose another schedule type|select one from the list)\b/i.test(
      raw,
    ) && isScheduleTypePrompt(raw)
  );
}

/**
 * When step is `modules` or `schedule_types`, most assistant text is only shown inside the inline picker.
 * Capacity / validation replies must also appear as timeline bubbles so the flow reads
 * user â†’ assistant â†’ user, not several user rows with no visible reply.
 */
function isAwaitingModulesTimelineAssistantSurface(raw: string): boolean {
  const t = (raw ?? '').trim();
  if (!t) return false;
  if (isScheduleTypeRetryMessage(t)) return true;
  if (/^great\b/i.test(t) && /\bhere are the\b/i.test(t)) return false;
  if (/\bwhich kind of rotational schedule\b/i.test(t)) return false;
  if (/\bchoose a \*\*schedule type\*\*/i.test(t)) return false;
  if (/\bselect\s+the\s+schedule\s+type\s+you\s+need\s+for\s+this\s+update\b/i.test(t)) return false;
  if (
    /\b(current capacity|must fit across module rows|please increase module rows\b|one or more module ids are invalid|no modules selected)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/\bfor rotation 1\b/i.test(t) && /\bstudents\b/i.test(t) && /\bcapacity\b/i.test(t)) {
    return true;
  }
  return false;
}

/** Intro for the inline schedule-type radio list (modules empty). */
function scheduleTypePickerIntroText(assistantMessage: string): string[] {
  const raw = (assistantMessage ?? '').trim();
  const stripped = stripNumberedListLines(raw);
  const isUpdateFlow =
    /previously\s+selected|for\s+this\s+update|need\s+for\s+this\s+update/i.test(raw) ||
    /\bselect\s+the\s+schedule\s+type\s+you\s+need\b/i.test(raw);
  if (!stripped) {
    return [
      isUpdateFlow
        ? 'Select the schedule type you need for this update, then tap **Confirm selection**. You can also reply with the type name or number in the chat.'
        : 'Choose the schedule type for this class, then tap **Confirm selection**. You can also reply with the type name or number in the chat.',
    ];
  }
  return stripped
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Intro paragraphs for the unified module picker (no numbered module lines). */
function modulePickerIntroText(
  assistantMessage: string,
  preselectedModuleCount: number,
  hasContentItems: boolean,
): string[] {
  const raw = (assistantMessage ?? '').trim();
  const looksLikeScheduleTypePrompt = isScheduleTypePrompt(raw);
  const isScheduleTypeRetry = isScheduleTypeRetryMessage(raw);
  /**
   * Always strip the numbered list lines: the schedule-type picker renders
   * radio options for each item, and the content picker renders the
   * numbered checkbox list. Showing the numbered text is redundant.
   */
  const stripped = stripNumberedListLines(raw);
  const lines: string[] = [];
  if (!looksLikeScheduleTypePrompt && preselectedModuleCount > 0) {
    lines.push(
      `${preselectedModuleCount} item${preselectedModuleCount === 1 ? '' : 's'} marked Selected are already on your current schedule”keep them checked to retain them, tick more to add, then confirm.`,
    );
  }
  if (stripped) {
    /** Retry/error explanation is shown in a separate assistant bubble. */
    if (isScheduleTypeRetry) {
      return lines;
    }
    /** Capacity / module validation: full text is in the chat thread; keep the embed short. */
    if (isAwaitingModulesTimelineAssistantSurface(raw) && !looksLikeScheduleTypePrompt) {
      lines.push('Use the checklist below to change your selection, then tap Confirm selection again.');
      return lines;
    }
    lines.push(
      ...stripped
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    );
  }
  if (lines.length === 0) {
    lines.push(
      'Choose which items to use for this rotation. Use Copy module if you need a second row for the same item (overflow students). Then confirm. You can also type names or numbers in the chat.',
    );
  }
  return lines;
}

/** API sends `rotationRangeMax` only while the user is editing start/end rotations. */
function isRotationRangeEditResponse(data: ApiResponse): boolean {
  return typeof data.rotationRangeMax === 'number' && data.rotationRangeMax >= 2;
}

function rotationRangePickerIntroText(assistantMessage: string): string {
  const stripped = (assistantMessage ?? '').trim();
  return stripped || 'Select the start and end rotation count to update, then confirm.';
}

function assistantMessageLooksLikeError(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /\b(cannot fit|could not|invalid|not valid|must fit|error|failed|no active|please (choose|increase|reduce)|widen the range)\b/i.test(
    t,
  );
}

/** Every API turn appends assistant content to the chat timeline (lists/errors stay in thread). */
function buildAssistantChatEntriesFromResponse(data: ApiResponse): Omit<ChatMessage, 'id'>[] {
  const raw = (data.assistantMessage ?? '').trim();
  const grid = pickScheduleFromPayload(data);
  const step = data.step;

  if (grid && (step === 'completed' || step === 'schedule')) {
    return [
      {
        role: 'assistant',
        text: raw || 'Here is your generated schedule.',
        schedule: grid,
        showSavePrompt: true,
      },
    ];
  }

  if (step === 'students') {
    return [
      {
        role: 'assistant',
        picker: {
          kind: 'students',
          frozen: false,
          intro: studentPickerIntroText(raw),
          students: data.students ?? [],
          selectedIds: (data.selectedStudents ?? []).map((s) => s.id),
        },
      },
    ];
  }

  if (step === 'schedule_types') {
    if (isScheduleTypeRetryMessage(raw)) {
      return [{ role: 'assistant', text: stripNumberedListLines(raw), isError: true }];
    }
    return [
      {
        role: 'assistant',
        picker: {
          kind: 'schedule_types',
          frozen: false,
          intro: scheduleTypePickerIntroText(raw),
          options: data.scheduleTypes ?? [],
        },
      },
    ];
  }

  if (step === 'modules') {
    if (isAwaitingModulesTimelineAssistantSurface(raw)) {
      return [
        {
          role: 'assistant',
          text: stripNumberedListLines(raw),
          isError: assistantMessageLooksLikeError(raw),
        },
      ];
    }
    return [
      {
        role: 'assistant',
        picker: {
          kind: 'modules',
          frozen: false,
          intro: modulePickerIntroText(
            raw,
            data.selectedModules?.length ?? 0,
            (data.modules?.length ?? 0) > 0,
          ),
          modules: data.modules ?? [],
          selectedIds: [
            ...new Set(
              (data.selectedModules ?? []).map((m) => catalogIdFromExpandedModuleRowId(m.id)),
            ),
          ],
          copyEachModule: false,
          copyModuleCount: '1',
          contentLabel: data.selectedScheduleType?.type === 'expedition' ? 'Expedition' : 'Module',
        },
      },
    ];
  }

  if (isRotationRangeEditResponse(data)) {
    const maxEnd = Math.max(2, data.rotationRangeMax!);
    return [
      {
        role: 'assistant',
        picker: {
          kind: 'rotation_range',
          frozen: false,
          intro: rotationRangePickerIntroText(raw),
          start: String(data.config?.startRotation ?? 1),
          end: String(data.config?.endRotation ?? maxEnd),
          maxEnd,
        },
      },
    ];
  }

  if (!raw) {
    return [{ role: 'assistant', text: '¦' }];
  }
  if (raw.includes('| --- |')) {
    return [{ role: 'assistant', text: raw, preformatted: true }];
  }
  const parts = raw
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const chunks = parts.length > 0 ? parts : [raw];
  return chunks.map((text) => ({
    role: 'assistant' as const,
    text,
    preformatted: text.includes('| --- |'),
    isError: assistantMessageLooksLikeError(text),
  }));
}

function filterNewScheduleChatEntries(
  entries: Omit<ChatMessage, 'id'>[],
  lastScheduleFingerprintRef: { current: string | null },
): Omit<ChatMessage, 'id'>[] {
  const out: Omit<ChatMessage, 'id'>[] = [];
  for (const entry of entries) {
    if (!entry.schedule) {
      out.push(entry);
      continue;
    }
    const fp = scheduleFingerprint(entry.schedule);
    if (fp === lastScheduleFingerprintRef.current) {
      if (entry.text?.trim()) {
        out.push({
          role: 'assistant',
          text: entry.text,
          isError: entry.isError,
          preformatted: entry.preformatted,
        });
      }
      continue;
    }
    lastScheduleFingerprintRef.current = fp;
    out.push(entry);
  }
  return out;
}

/** API JSON uses string keys "0" / "1" for the two seat slots. */
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

function scheduleStudentNames(schedule: NonNullable<ApiResponse['schedule']>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of schedule.seats ?? []) {
    for (const cell of row ?? []) {
      const first = getSeatSlot(cell, 0);
      const second = getSeatSlot(cell, 1);
      if (first !== '(empty)' && !seen.has(first)) {
        seen.add(first);
        names.push(first);
      }
      if (second !== '(empty)' && !seen.has(second)) {
        seen.add(second);
        names.push(second);
      }
    }
  }
  return names;
}

function scheduleRotationColumnCount(schedule: NonNullable<ApiResponse['schedule']>): number {
  const rows = schedule.seats ?? [];
  const widest = rows.reduce((max, row) => Math.max(max, row?.length ?? 0), 0);
  const n = Math.max(schedule.colCount ?? 0, widest);
  return n > 0 ? n : 1;
}

/** Render primary module row followed immediately by its copy rows. */
function scheduleRowDisplayOrder(schedule: NonNullable<ApiResponse['schedule']>): number[] {
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

function scheduleFingerprint(schedule: NonNullable<ApiResponse['schedule']>): string {
  return JSON.stringify({
    seats: schedule.seats ?? [],
    rowData: schedule.rowData ?? [],
    rowCount: schedule.rowCount ?? 0,
    colCount: schedule.colCount ?? 0,
  });
}

/** Nest interceptor may add statusCode/success/message; some proxies nest the body under `data`. */
function unwrapAiRotationalPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const nested = raw.data;
  if (
    nested &&
    typeof nested === 'object' &&
    !Array.isArray(nested) &&
    'sessionId' in nested &&
    typeof (nested as { sessionId?: unknown }).sessionId === 'string'
  ) {
    return nested as Record<string, unknown>;
  }
  return raw;
}

function pickScheduleFromPayload(data: ApiResponse): ApiResponse['schedule'] | null {
  const s = data.schedule;
  if (s == null || typeof s !== 'object') {
    return null;
  }
  if (!Array.isArray((s as { seats?: unknown }).seats)) {
    return null;
  }
  return s as ApiResponse['schedule'];
}

/** Prefer fresh grid from the response; keep last grid when API omits it (e.g. reopening module picker after `completed`). */
function mergePersistedSchedule(data: ApiResponse, previous: ApiResponse['schedule'] | null): ApiResponse['schedule'] | null {
  const picked = pickScheduleFromPayload(data);
  if (picked !== null) {
    return picked;
  }
  if (
    data.step === 'completed' ||
    data.step === 'schedule' ||
    data.step === 'modules' ||
    data.step === 'schedule_types' ||
    data.step === 'students'
  ) {
    return previous;
  }
  return null;
}

/** Copy rows expand `selectedModules` with synthetic suffixes; checklist rows use catalog ids. */
function catalogIdFromExpandedModuleRowId(id: string): string {
  return id.replace(/::__copy_\d+(?:_\d+)?$/i, '');
}

function ScheduleGridTable({
  schedule,
  scrollable = false,
  savePrompt,
  showExpandControl = true,
  expandTitle = 'Schedule overview',
}: {
  schedule: NonNullable<ApiResponse['schedule']>;
  scrollable?: boolean;
  savePrompt?: { onYes: () => void; onNo: () => void; saving?: boolean };
  /** Inline compact view only — opens dedicated full-page view (not an overlay). */
  showExpandControl?: boolean;
  expandTitle?: string;
}) {
  const rotationCols = scheduleRotationColumnCount(schedule);
  const orderedRows = scheduleRowDisplayOrder(schedule);
  const useScroll = scrollable || Boolean(savePrompt);

  const openFullPage = () => {
    openScheduleFullView({ schedule, title: expandTitle });
  };

  const table = (
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

  const compactToolbar =
    useScroll && showExpandControl ? (
      <div className="schedule-compact-toolbar">
        <span className="schedule-compact-hint">Scroll to explore the grid</span>
        <button type="button" className="btn-schedule-expand" onClick={openFullPage}>
          Expand full table
        </button>
      </div>
    ) : null;

  if (!savePrompt) {
    return (
      <>
        {compactToolbar}
        <div className={`schedule-table-wrap${useScroll ? ' schedule-table-wrap--scroll' : ''}`}>{table}</div>
      </>
    );
  }

  return (
    <div className="schedule-card">
      {compactToolbar}
      <div className="schedule-table-wrap schedule-table-wrap--scroll">{table}</div>
      <footer className="schedule-save-prompt">
        <p className="schedule-save-prompt-text">Would you like to save this schedule?</p>
        <div className="schedule-save-actions">
          <button className="btn btn-outline" type="button" disabled={savePrompt.saving} onClick={savePrompt.onNo}>
            No
          </button>
          <button className="btn primary" type="button" disabled={savePrompt.saving} onClick={savePrompt.onYes}>
            {savePrompt.saving ? 'Saving…' : 'Yes, save'}
          </button>
        </div>
      </footer>
    </div>
  );
}

type CompletedScheduleEntry = {
  id: string;
  sessionId: string;
  classId: string;
  schedule: NonNullable<ApiResponse['schedule']>;
  generatedAt: number;
  savedScheduleId?: string;
};

export default function App() {
  const [scheduleFullView, setScheduleFullView] = useState(() => isScheduleFullViewPath());

  useEffect(() => {
    migrateLegacyScheduleFullHash();
    const syncView = () => setScheduleFullView(isScheduleFullViewPath());
    syncView();
    window.addEventListener('popstate', syncView);
    window.addEventListener(SCHEDULE_VIEW_SYNC_EVENT, syncView);
    return () => {
      window.removeEventListener('popstate', syncView);
      window.removeEventListener(SCHEDULE_VIEW_SYNC_EVENT, syncView);
    };
  }, []);

  const [sessionId, setSessionId] = useState('');
  const [currentClassId, setCurrentClassId] = useState('');
  const [completedSchedules, setCompletedSchedules] = useState<CompletedScheduleEntry[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatMode, setChatMode] = useState<ChatMode>('awaiting_intent');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  /** Keeps the last generated grid if a later API message omits `schedule`. */
  const [persistedSchedule, setPersistedSchedule] = useState<ApiResponse['schedule'] | null>(null);
  const [studentSelection, setStudentSelection] = useState<string[]>([]);
  const [moduleSelection, setModuleSelection] = useState<string[]>([]);
  const [scheduleTypeSelection, setScheduleTypeSelection] = useState<string>('');
  const [copyEachModule, setCopyEachModule] = useState(false);
  const [copyModuleCount, setCopyModuleCount] = useState('1');
  const [startRotationSelection, setStartRotationSelection] = useState('1');
  const [endRotationSelection, setEndRotationSelection] = useState('2');
  const [error, setError] = useState('');
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [savedScheduleId, setSavedScheduleId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: nextMessageId(),
      role: 'assistant',
      text: "Hello! I'm your AI Assistant for creating smart rotational schedules.",
    },
  ]);

  const chatThreadRef = useRef<HTMLDivElement>(null);
  /** Skip duplicate schedule cards in chat when the grid unchanged. */
  const lastChatScheduleFingerprintRef = useRef<string | null>(null);
  /** True once the user has reached `completed` with a grid ” used to skip chat auto-scroll during module-edit interrupts. */
  const completedScheduleEverRef = useRef(false);
  /** Avoid double `scrollIntoView` in React Strict Mode for the same bubble. */
  const moduleCapacityScrollDoneForMessageIdRef = useRef<string | null>(null);

  const appendMessages = useCallback((entries: Omit<ChatMessage, 'id'>[]) => {
    setChatMessages((prev) => [...prev, ...entries.map((e) => ({ ...e, id: nextMessageId() }))]);
  }, []);

  const appendUserText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      appendMessages([{ role: 'user', text: trimmed }]);
    },
    [appendMessages],
  );

  const appendUserSelection = useCallback(
    (heading: string, items: string[], footnote?: string) => {
      if (items.length === 0) {
        return;
      }
      appendMessages([
        {
          role: 'user',
          heading,
          items,
          ...(footnote?.trim() ? { text: footnote.trim() } : {}),
        },
      ]);
    },
    [appendMessages],
  );

  useEffect(() => {
    lastChatScheduleFingerprintRef.current = null;
    completedScheduleEverRef.current = false;
  }, [sessionId]);

  /** If the user confirms via chat text, freeze any picker left open when the step advances. */
  useEffect(() => {
    if (!response) {
      return;
    }
    const activeKind = stepToPickerKind(response.step);
    setChatMessages((prev) =>
      prev.map((m) => {
        if (!m.picker || m.picker.frozen || m.picker.kind === activeKind) {
          return m;
        }
        const p = m.picker;
        if (p.kind === 'schedule_types') {
          return {
            ...m,
            picker: { ...p, frozen: true, selectedId: scheduleTypeSelection || p.selectedId },
          };
        }
        if (p.kind === 'modules') {
          return {
            ...m,
            picker: {
              ...p,
              frozen: true,
              selectedIds: moduleSelection.length > 0 ? [...moduleSelection] : p.selectedIds,
              copyEachModule,
              copyModuleCount,
            },
          };
        }
        if (p.kind === 'students') {
          return {
            ...m,
            picker: {
              ...p,
              frozen: true,
              selectedIds: studentSelection.length > 0 ? [...studentSelection] : p.selectedIds,
            },
          };
        }
        if (p.kind === 'rotation_range') {
          return {
            ...m,
            picker: {
              ...p,
              frozen: true,
              start: startRotationSelection,
              end: endRotationSelection,
            },
          };
        }
        return m;
      }),
    );
  }, [
    response?.step,
    response?.sessionId,
    scheduleTypeSelection,
    moduleSelection,
    studentSelection,
    copyEachModule,
    copyModuleCount,
    startRotationSelection,
    endRotationSelection,
  ]);

  const appendAssistantEntriesFromResponse = useCallback((data: ApiResponse) => {
    const entries = filterNewScheduleChatEntries(
      buildAssistantChatEntriesFromResponse(data),
      lastChatScheduleFingerprintRef,
    );
    if (entries.length === 0) {
      return;
    }
    setChatMessages((prev) => {
      const toAdd: ChatMessage[] = [];
      for (const entry of entries) {
        if (
          entry.picker &&
          prev.some((m) => m.picker?.kind === entry.picker!.kind && !m.picker.frozen)
        ) {
          continue;
        }
        toAdd.push({ ...entry, id: nextMessageId() });
      }
      return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
    });
  }, []);

  const freezePickerInChat = useCallback((kind: ChatPicker['kind'], finalize: (picker: ChatPicker) => ChatPicker) => {
    setChatMessages((prev) =>
      prev.map((m) => {
        if (!m.picker || m.picker.kind !== kind || m.picker.frozen) {
          return m;
        }
        return { ...m, picker: finalize(m.picker) };
      }),
    );
  }, []);

  useEffect(() => {
    const last = chatMessages[chatMessages.length - 1];
    const lastId = last?.id ?? null;

    const moduleTimelineError =
      response?.step === 'modules' &&
      isAwaitingModulesTimelineAssistantSurface((response.assistantMessage ?? '').trim());

    if (moduleTimelineError && last?.role === 'assistant' && lastId) {
      if (moduleCapacityScrollDoneForMessageIdRef.current !== lastId) {
        moduleCapacityScrollDoneForMessageIdRef.current = lastId;
        requestAnimationFrame(() => {
          document.getElementById(`chat-msg-${lastId}`)?.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
            inline: 'nearest',
          });
        });
      }
      return;
    }

    /**
     * After a schedule exists, reopening modules (`modules` step) appends assistant text + inline picker.
     * Scrolling `threadEndRef` into view walks scroll parents and often yanks the **page** down to the
     * schedule below the composer. Skip that auto-scroll during this interrupt; user stays on the chat/picker.
     */
    if (
      (response?.step === 'modules' || response?.step === 'students') &&
      completedScheduleEverRef.current
    ) {
      return;
    }

    const thread = chatThreadRef.current;
    if (!thread) {
      return;
    }
    thread.scrollTo({
      top: thread.scrollHeight,
      behavior: 'smooth',
    });
  }, [chatMessages, loading, response?.step, response?.assistantMessage]);

  const selectedModuleIdsSig = [...new Set((response?.selectedModules ?? []).map((m) => catalogIdFromExpandedModuleRowId(m.id)))].join('|');
  useEffect(() => {
    if (response?.step !== 'modules') {
      return;
    }
    const ids = [...new Set((response.selectedModules ?? []).map((m) => catalogIdFromExpandedModuleRowId(m.id)))];
    setModuleSelection(ids);
  }, [response?.sessionId, response?.step, selectedModuleIdsSig]);

  const selectedStudentIdsSig = (response?.selectedStudents ?? []).map((s) => s.id).join('|');
  useEffect(() => {
    if (response?.step !== 'students') {
      return;
    }
    setStudentSelection((response.selectedStudents ?? []).map((s) => s.id));
  }, [response?.sessionId, response?.step, selectedStudentIdsSig]);

  /** Reset the schedule-type radio selection whenever the list or step changes. */
  const scheduleTypesSig = (response?.scheduleTypes ?? []).map((t) => t.id).join('|');
  const hasContentList = (response?.modules?.length ?? 0) > 0;
  useEffect(() => {
    setScheduleTypeSelection('');
  }, [response?.sessionId, response?.step, scheduleTypesSig, hasContentList]);

  useEffect(() => {
    if (!response || !isRotationRangeEditResponse(response)) {
      return;
    }
    const maxEnd = Math.max(2, response.rotationRangeMax!);
    const curStart = response.config?.startRotation ?? 1;
    const curEnd = response.config?.endRotation ?? maxEnd;
    setStartRotationSelection(String(Math.min(Math.max(1, curStart), maxEnd - 1)));
    setEndRotationSelection(String(Math.min(Math.max(curEnd, 2), maxEnd)));
  }, [
    response?.sessionId,
    response?.step,
    response?.rotationRangeMax,
    response?.config?.startRotation,
    response?.config?.endRotation,
  ]);

  const normalizedSchedule = response ? pickScheduleFromPayload(response) : null;
  /** Keep showing the last grid when reopening module/student pick after `completed` (API may omit `schedule` on interrupt steps). */
  const displaySchedule =
    normalizedSchedule ??
    (response?.step === 'completed' ||
    response?.step === 'modules' ||
    response?.step === 'schedule_types' ||
    response?.step === 'students' ||
    (response != null && isRotationRangeEditResponse(response))
      ? persistedSchedule
      : null);

  /**
   * Remember that the user has seen a completed grid (for interrupt scroll behavior).
   */
  useEffect(() => {
    if (!response || response.sessionId !== sessionId) {
      return;
    }
    if (response.step !== 'completed') {
      return;
    }
    const grid = normalizedSchedule ?? persistedSchedule;
    if (grid) {
      completedScheduleEverRef.current = true;
    }
  }, [response, sessionId, normalizedSchedule, persistedSchedule]);

  const selectedStudentNamesSig = (response?.selectedStudents ?? []).map((s) => s.fullName).join('|');
  useEffect(() => {
    if (!response) {
      return;
    }
    const selectedNames = (response.selectedStudents ?? []).map((s) => s.fullName);
    const generatedNames = displaySchedule ? scheduleStudentNames(displaySchedule) : [];
  }, [response?.sessionId, response?.step, selectedStudentNamesSig, displaySchedule]);

  const canSend = chatInput.trim().length > 0 && !loading;

  const scheduleStepShowsGrid =
    response?.step === 'schedule' || response?.step === 'completed';

  const canSaveCurrentSchedule =
    Boolean(sessionId) &&
    scheduleStepShowsGrid &&
    displaySchedule != null &&
    !savingSchedule &&
    !savedScheduleId;

  function handleSaveScheduleNo() {
    appendMessages([{ role: 'assistant', text: 'OK — tell me if you want any other changes.' }]);
  }

  async function saveCurrentSchedule(targetSessionId: string) {
    setSavingSchedule(true);
    setError('');
    try {
      const controller = new AbortController();
      const saveTimeoutMs = 15 * 60 * 1000;
      const timeoutId = window.setTimeout(() => controller.abort(), saveTimeoutMs);
      const res = await fetch(`${apiBase}/ai-rotational/session/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: targetSessionId }),
        signal: controller.signal,
      });
      window.clearTimeout(timeoutId);
      const raw = (await res.json()) as Record<string, unknown>;
      const unwrapped = unwrapAiRotationalPayload(raw) as Record<string, unknown>;
      if (!res.ok) {
        const errMsg =
          (typeof unwrapped.assistantMessage === 'string' && unwrapped.assistantMessage) ||
          (typeof raw.message === 'string' && raw.message) ||
          'Save failed';
        throw new Error(errMsg);
      }
      const scheduleId =
        typeof unwrapped.scheduleId === 'string' ? unwrapped.scheduleId : '';
      if (scheduleId) {
        setSavedScheduleId(scheduleId);
      }
      const assistantMessage =
        typeof unwrapped.assistantMessage === 'string'
          ? unwrapped.assistantMessage
          : 'Schedule saved successfully.';
      appendMessages([{ role: 'assistant', text: assistantMessage }]);
    } catch (e) {
      const msg =
        e instanceof Error && e.name === 'AbortError'
          ? 'Save timed out after 15 minutes. The schedule may still be saving on the server — check Star Academy or server logs ([session/save]).'
          : e instanceof Error
            ? e.message
            : 'Save failed';
      setError(msg);
      appendMessages([{ role: 'assistant', text: `Something went wrong: ${msg}`, isError: true }]);
    } finally {
      setSavingSchedule(false);
    }
  }

  async function startSession(classId: string, initialMessage?: string) {
    setLoading(true);
    setError('');
    try {
      const body: { classId: string; message?: string } = { classId };
      const seed = initialMessage?.trim();
      if (seed) {
        body.message = seed;
      }
      const res = await fetch(`${apiBase}/ai-rotational/session/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const raw = (await res.json()) as Record<string, unknown>;
      const unwrapped = unwrapAiRotationalPayload(raw) as Record<string, unknown>;
      const data = mergePartialAiResponse(null, unwrapped);
      if (!res.ok) {
        throw new Error(
          String((raw as { message?: string }).message ?? (unwrapped as { message?: string }).message ?? 'Failed to start session'),
        );
      }
      setResponse(data);
      setSessionId(data.sessionId);
      setCurrentClassId(classId);
      setChatMode('active');
      setPersistedSchedule(mergePersistedSchedule(data, null));
      setStudentSelection([]);
      setModuleSelection([]);
      setCopyEachModule(false);
      setCopyModuleCount('1');
      appendAssistantEntriesFromResponse(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  type SessionModuleIdsPayload = {
    moduleIds: string[];
    copyEachSelectedModule?: boolean;
    copyModuleCount?: number;
  };

  async function sendMessage(payload: string | SessionModuleIdsPayload) {
    const activeSessionId = sessionId;
    if (!activeSessionId) return;
    setLoading(true);
    setError('');
    try {
      const body =
        typeof payload === 'string'
          ? { sessionId: activeSessionId, message: payload }
          : {
              sessionId: activeSessionId,
              moduleIds: payload.moduleIds,
              ...(payload.copyEachSelectedModule === true
                ? {
                    copyEachSelectedModule: true,
                    copyModuleCount:
                      typeof payload.copyModuleCount === 'number' &&
                      Number.isInteger(payload.copyModuleCount) &&
                      payload.copyModuleCount >= 1
                        ? payload.copyModuleCount
                        : 1,
                  }
                : {}),
            };
      const res = await fetch(`${apiBase}/ai-rotational/session/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const raw = (await res.json()) as Record<string, unknown>;
      const unwrapped = unwrapAiRotationalPayload(raw) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(
          String((raw as { message?: string }).message ?? (unwrapped as { message?: string }).message ?? 'Message failed'),
        );
      }
      const merged = mergePartialAiResponse(response, unwrapped);
      setResponse(merged);
      setPersistedSchedule((prev) => mergePersistedSchedule(merged, prev));
      appendAssistantEntriesFromResponse(merged);
    } catch (err) {
      setError((err as Error).message);
      appendMessages([{ role: 'assistant', text: `Something went wrong: ${(err as Error).message}`, isError: true }]);
    } finally {
      setLoading(false);
    }
  }

  function archiveCurrentScheduleAndResetForNewFlow(triggerMessage: string): boolean {
    const schedule = displaySchedule;
    if (schedule) {
      setCompletedSchedules((prev) => [
        ...prev,
        {
          id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          sessionId,
          classId: currentClassId,
          schedule,
          generatedAt: Date.now(),
          savedScheduleId: savedScheduleId ?? undefined,
        },
      ]);
    }
    setSessionId('');
    setCurrentClassId('');
    setResponse(null);
    setPersistedSchedule(null);
    setSavedScheduleId(null);
    setStudentSelection([]);
    setModuleSelection([]);
    setScheduleTypeSelection('');
    setCopyEachModule(false);
    setCopyModuleCount('1');
    setError('');
    setChatMode('awaiting_class_id');
    lastChatScheduleFingerprintRef.current = null;
    completedScheduleEverRef.current = false;
    moduleCapacityScrollDoneForMessageIdRef.current = null;
    appendMessages([
      {
        role: 'assistant',
        text: "Sure ” let's create another rotational schedule. Please provide the new class ID.",
      },
    ]);
    return true;
  }

  async function onSubmitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message) {
      return;
    }
    setChatInput('');
    appendUserText(message);

    /**
     * After a schedule is generated, accept "create new schedule" / "another schedule" /
     * "new rotational schedule" as a shortcut that resets the session and asks for a fresh class ID.
     * Inline class IDs in the same message are honored so the user can skip the prompt.
     */
    if (sessionId && response?.step === 'completed' && isCreateNewScheduleIntent(message)) {
      const inlineClassId = extractClassIdFromMessage(message);
      const handled = archiveCurrentScheduleAndResetForNewFlow(message);
      if (handled && inlineClassId) {
        await startSession(inlineClassId, message);
      }
      return;
    }

    if (!sessionId) {
      if (chatMode === 'awaiting_intent') {
        /**
         * Accept a bare Mongo ObjectId (or message that contains one) before
         * requiring rotational phrasing ” matches "paste class ID only" UX.
         */
        const inlineClassIdEarly = extractClassIdFromMessage(message);
        if (inlineClassIdEarly) {
          await startSession(inlineClassIdEarly, message);
          return;
        }
        if (!isRotationalIntent(message)) {
          appendMessages([
            {
              role: 'assistant',
              text: 'I can help with rotational schedule creation. Please ask to create a rotational schedule.',
            },
          ]);
          return;
        }
        setChatMode('awaiting_class_id');
        appendMessages([{ role: 'assistant', text: 'Please provide the class ID.' }]);
        return;
      }
      const inlineClassId = extractClassIdFromMessage(message);
      if (!inlineClassId) {
        appendMessages([
          {
            role: 'assistant',
            text: 'Please provide a valid 24-character class ID.',
          },
        ]);
        return;
      }
      await startSession(inlineClassId, message);
      return;
    }
    await sendMessage(message);
  }

  async function confirmStudentSelection() {
    if (!response || response.step !== 'students') return;
    if (loading) return;
    if (studentSelection.length === 0) return;
    const names = studentSelection
      .map((id) => response.students.find((s) => s.id === id)?.fullName ?? id)
      .filter(Boolean);
    freezePickerInChat('students', (p) =>
      p.kind === 'students' ? { ...p, frozen: true, selectedIds: [...studentSelection] } : p,
    );
    appendUserSelection(`Selected students (${names.length})`, names);
    const idsJson = JSON.stringify(studentSelection);
    await sendMessage(
      `I confirm these students for the rotation: ${names.join(', ')}. Call select_students with studentIds exactly ${idsJson}, then continue the workflow.`,
    );
  }

  async function confirmScheduleTypeSelection() {
    if (!response || response.step !== 'schedule_types') return;
    if (loading) return;
    const pickedId = scheduleTypeSelection;
    if (!pickedId) return;
    const picked = (response.scheduleTypes ?? []).find((t) => t.id === pickedId);
    if (!picked) return;
    freezePickerInChat('schedule_types', (p) =>
      p.kind === 'schedule_types' ? { ...p, frozen: true, selectedId: pickedId } : p,
    );
    appendUserText(picked.name);
    await sendMessage(picked.name);
  }

  async function confirmModuleSelection() {
    if (!response || response.step !== 'modules') return;
    if (loading) return;
    if (moduleSelection.length === 0) return;
    const names = moduleSelection
      .map((id) => response.modules.find((m) => m.id === id)?.name ?? id)
      .filter(Boolean);
    freezePickerInChat('modules', (p) =>
      p.kind === 'modules'
        ? {
            ...p,
            frozen: true,
            selectedIds: [...moduleSelection],
            copyEachModule,
            copyModuleCount,
          }
        : p,
    );
    const parsedCopyCount = Number.parseInt(copyModuleCount, 10);
    const normalizedCopyCount = Number.isInteger(parsedCopyCount) && parsedCopyCount > 0 ? parsedCopyCount : 1;
    const copyFootnote = copyEachModule
      ? `Copy each module ${normalizedCopyCount} time${normalizedCopyCount === 1 ? '' : 's'}.`
      : undefined;
    appendUserSelection(`Selected modules (${names.length})`, names, copyFootnote);
    const payload: SessionModuleIdsPayload = { moduleIds: [...moduleSelection] };
    if (copyEachModule) {
      payload.copyEachSelectedModule = true;
      payload.copyModuleCount = normalizedCopyCount;
    }
    await sendMessage(payload);
  }

  function rotationRangeSpanValid(start: number, end: number, maxEnd: number): boolean {
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (start < 1 || start > maxEnd - 1) return false;
    if (end <= start || end > maxEnd) return false;
    return true;
  }

  async function confirmRotationRangeSelection() {
    if (!response || !isRotationRangeEditResponse(response)) return;
    if (loading) return;
    const maxEnd = Math.max(2, response.rotationRangeMax!);
    const start = Number.parseInt(startRotationSelection, 10);
    const end = Number.parseInt(endRotationSelection, 10);
    if (!rotationRangeSpanValid(start, end, maxEnd)) return;

    freezePickerInChat('rotation_range', (p) =>
      p.kind === 'rotation_range' ? { ...p, frozen: true, start: String(start), end: String(end) } : p,
    );
    appendUserText(`Rotations ${start}–${end}`);
    await sendMessage(`start rotation exactly ${start} end rotation exactly ${end}`);
  }

  function stepToPickerKind(step: ResponseStep | undefined): ChatPicker['kind'] | null {
    if (step === 'schedule_types') return 'schedule_types';
    if (step === 'modules') return 'modules';
    if (step === 'students') return 'students';
    if (response && isRotationRangeEditResponse(response)) return 'rotation_range';
    return null;
  }

  function renderInlinePicker(message: ChatMessage) {
    const picker = message.picker;
    if (!picker) {
      return null;
    }
    const activeKind = stepToPickerKind(response?.step);
    const interactive = !picker.frozen && picker.kind === activeKind && !loading;

    if (picker.kind === 'schedule_types') {
      const selectedId = interactive ? scheduleTypeSelection : (picker.selectedId ?? '');
      return (
        <div className={`bubble-embed-unified${picker.frozen ? ' bubble-embed-frozen' : ''}`}>
          {picker.intro.map((para, i) => (
            <p key={i} className="bubble-text bubble-text-tight">
              {para}
            </p>
          ))}
          <div className="inline-pick-head" aria-hidden>
            <span className="inline-pick-head-num">#</span>
            <span className="inline-pick-head-ch"> </span>
            <span className="inline-pick-head-name">Schedule type</span>
          </div>
          <ul className="inline-pick-list inline-pick-list-numbered" aria-label="Schedule types">
            {picker.options.map((item, index) => (
              <li key={item.id}>
                <label className="inline-pick-row inline-pick-row-numbered inline-pick-row-modules">
                  <span className="inline-pick-number" aria-hidden>
                    {index + 1}.
                  </span>
                  <input
                    type="radio"
                    name={`schedule-type-${message.id}`}
                    checked={selectedId === item.id}
                    disabled={!interactive}
                    onChange={() => interactive && setScheduleTypeSelection(item.id)}
                  />
                  <span className="inline-pick-name">{item.name}</span>
                </label>
              </li>
            ))}
          </ul>
          {interactive && (
            <div className="bubble-actions">
              <button
                className="btn primary"
                type="button"
                disabled={!scheduleTypeSelection}
                onClick={confirmScheduleTypeSelection}
              >
                Confirm selection
              </button>
            </div>
          )}
        </div>
      );
    }

    if (picker.kind === 'students') {
      const selected = interactive ? studentSelection : picker.selectedIds;
      return (
        <div className={`bubble-embed-unified${picker.frozen ? ' bubble-embed-frozen' : ''}`}>
          {picker.intro.map((para, i) => (
            <p key={i} className="bubble-text bubble-text-tight">
              {para}
            </p>
          ))}
          <div className="inline-pick-head" aria-hidden>
            <span className="inline-pick-head-num">#</span>
            <span className="inline-pick-head-ch"> </span>
            <span className="inline-pick-head-name">Student</span>
            <span className="inline-pick-head-selected">Selected</span>
          </div>
          {!picker.frozen && (
            <label className="inline-pick-row inline-pick-row-numbered inline-pick-row-modules">
              <span className="inline-pick-number" aria-hidden>
                0.
              </span>
              <input
                type="checkbox"
                checked={picker.students.length > 0 && picker.students.every((s) => selected.includes(s.id))}
                disabled={!interactive}
                onChange={() =>
                  interactive &&
                  toggleAllIds(
                    picker.students.map((s) => s.id),
                    studentSelection,
                    setStudentSelection,
                  )
                }
              />
              <span className="inline-pick-name">Select all students</span>
            </label>
          )}
          <ul className="inline-pick-list inline-pick-list-numbered">
            {picker.students.map((student, index) => {
              const isSelected = selected.includes(student.id);
              return (
                <li key={student.id}>
                  <label className="inline-pick-row inline-pick-row-numbered inline-pick-row-modules">
                    <span className="inline-pick-number" aria-hidden>
                      {index + 1}.
                    </span>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={!interactive}
                      onChange={() => interactive && toggleId(student.id, studentSelection, setStudentSelection)}
                    />
                    <span className="inline-pick-name">{student.fullName}</span>
                    <span className="inline-pick-selected-cell">
                      {isSelected ? (
                        <span className="inline-pick-selected-yes">Yes</span>
                      ) : (
                        <span className="inline-pick-selected-dash">”</span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {interactive && (
            <div className="bubble-actions">
              <button
                className="btn primary"
                type="button"
                disabled={studentSelection.length === 0}
                onClick={confirmStudentSelection}
              >
                Confirm selection
              </button>
            </div>
          )}
        </div>
      );
    }

    if (picker.kind === 'modules') {
      const selected = interactive ? moduleSelection : picker.selectedIds;
      return (
        <div className={`bubble-embed-unified${picker.frozen ? ' bubble-embed-frozen' : ''}`}>
          {picker.intro.map((para, i) => (
            <p key={i} className="bubble-text bubble-text-tight">
              {para}
            </p>
          ))}
          <div className="inline-pick-head" aria-hidden>
            <span className="inline-pick-head-num">#</span>
            <span className="inline-pick-head-ch"> </span>
            <span className="inline-pick-head-name">{picker.contentLabel}</span>
            <span className="inline-pick-head-selected">Selected</span>
          </div>
          {interactive && (
            <label className="inline-pick-row inline-pick-row-numbered inline-pick-row-modules">
              <span className="inline-pick-number" aria-hidden>
                0.
              </span>
              <input
                type="checkbox"
                checked={picker.modules.length > 0 && picker.modules.every((m) => selected.includes(m.id))}
                onChange={() =>
                  toggleAllIds(
                    picker.modules.map((m) => m.id),
                    moduleSelection,
                    setModuleSelection,
                  )
                }
              />
              <span className="inline-pick-name">Select all</span>
            </label>
          )}
          <ul className="inline-pick-list inline-pick-list-numbered">
            {picker.modules.map((moduleItem, index) => {
              const isSelected = selected.includes(moduleItem.id);
              return (
                <li key={moduleItem.id}>
                  <label className="inline-pick-row inline-pick-row-numbered inline-pick-row-modules">
                    <span className="inline-pick-number" aria-hidden>
                      {index + 1}.
                    </span>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={!interactive}
                      onChange={() => interactive && toggleId(moduleItem.id, moduleSelection, setModuleSelection)}
                    />
                    <span className="inline-pick-name">{moduleItem.name}</span>
                    <span className="inline-pick-selected-cell">
                      {isSelected ? (
                        <span className="inline-pick-selected-yes">Yes</span>
                      ) : (
                        <span className="inline-pick-selected-dash">”</span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {interactive && (
            <>
              <label className="inline-pick-row copy-module-option">
                <input
                  type="checkbox"
                  checked={copyEachModule}
                  onChange={(event) => setCopyEachModule(event.target.checked)}
                />
                <span>Copy module ” Select if you need a copy module</span>
              </label>
              <label className="copy-module-count" htmlFor={`copy-module-count-${message.id}`}>
                <span>Enter copy module</span>
                <input
                  id={`copy-module-count-${message.id}`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={copyModuleCount}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === '' || /^\d+$/.test(raw)) {
                      setCopyModuleCount(raw);
                    }
                  }}
                  disabled={!copyEachModule}
                />
              </label>
              <div className="bubble-actions">
                <button
                  className="btn primary"
                  type="button"
                  disabled={
                    moduleSelection.length === 0 ||
                    (copyEachModule && !/^[1-9]\d*$/.test(copyModuleCount))
                  }
                  onClick={confirmModuleSelection}
                >
                  Confirm selection
                </button>
              </div>
            </>
          )}
          {picker.frozen && picker.copyEachModule && (
            <p className="bubble-text bubble-text-tight bubble-footnote">
              Copy module: {picker.copyModuleCount} row(s) per module
            </p>
          )}
        </div>
      );
    }

    if (picker.kind === 'rotation_range') {
      const startVal = interactive ? startRotationSelection : picker.start;
      const endVal = interactive ? endRotationSelection : picker.end;
      const maxEnd = picker.maxEnd;
      return (
        <div className={`bubble-embed-unified${picker.frozen ? ' bubble-embed-frozen' : ''}`}>
          <p className="bubble-text bubble-text-tight">{picker.intro}</p>
          <label className="copy-module-count" htmlFor={`start-rotation-${message.id}`}>
            <span>Start rotation</span>
            <input
              id={`start-rotation-${message.id}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={Math.max(1, maxEnd - 1)}
              step={1}
              value={startVal}
              disabled={!interactive}
              onChange={(event) => {
                const raw = event.target.value;
                if (raw === '' || /^\d+$/.test(raw)) {
                  setStartRotationSelection(raw);
                }
              }}
            />
          </label>
          <label className="copy-module-count" htmlFor={`end-rotation-${message.id}`}>
            <span>End rotation</span>
            <input
              id={`end-rotation-${message.id}`}
              type="number"
              inputMode="numeric"
              min={2}
              max={maxEnd}
              step={1}
              value={endVal}
              disabled={!interactive}
              onChange={(event) => {
                const raw = event.target.value;
                if (raw === '' || /^\d+$/.test(raw)) {
                  setEndRotationSelection(raw);
                }
              }}
            />
          </label>
          {interactive && (
            <div className="bubble-actions">
              <button
                className="btn primary"
                type="button"
                disabled={
                  !rotationRangeSpanValid(
                    Number.parseInt(startRotationSelection, 10),
                    Number.parseInt(endRotationSelection, 10),
                    maxEnd,
                  )
                }
                onClick={confirmRotationRangeSelection}
              >
                Confirm rotation range
              </button>
            </div>
          )}
        </div>
      );
    }

    return null;
  }

  function renderMessageBody(message: ChatMessage) {
    if (message.role === 'user') {
      if (message.heading || (message.items && message.items.length > 0)) {
        return (
          <div className="bubble-body">
            {message.heading && <div className="bubble-heading">{message.heading}</div>}
            {message.items && message.items.length > 0 && (
              <ol className="bubble-list">
                {message.items.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ol>
            )}
            {message.text && <p className="bubble-footnote">{message.text}</p>}
          </div>
        );
      }
      if (message.text?.trim()) {
        return <p className="bubble-text">{message.text}</p>;
      }
      return null;
    }
    if (message.schedule) {
      return (
        <div className="schedule-in-chat">
          {message.text && <p className="bubble-text bubble-text-tight">{message.text}</p>}
          <ScheduleGridTable
            schedule={message.schedule}
            scrollable={!message.showSavePrompt}
            savePrompt={
              message.showSavePrompt && !savedScheduleId
                ? {
                    onNo: handleSaveScheduleNo,
                    onYes: () => void saveCurrentSchedule(sessionId),
                    saving: savingSchedule,
                  }
                : undefined
            }
          />
        </div>
      );
    }
    if (message.picker) {
      return renderInlinePicker(message);
    }

    if (message.preformatted && message.text) {
      return <pre className="bubble-text bubble-pre-table">{message.text}</pre>;
    }
    return <p className="bubble-text">{message.text}</p>;
  }

  if (scheduleFullView) {
    return (
      <ScheduleFullPageRoute
        onClose={() => {
          closeScheduleFullView();
          setScheduleFullView(false);
        }}
      />
    );
  }

  return (
    <main className="page">
      <section className="card">
        <h1>AI Rotational Scheduler</h1>

        <div ref={chatThreadRef} className="chat-thread" role="log" aria-live="polite">
          {chatMessages.map((message) => {
            const body = renderMessageBody(message);
            if (!body) {
              return null;
            }
            return (
              <div
                key={message.id}
                id={`chat-msg-${message.id}`}
                className={`msg-row ${message.role === 'user' ? 'msg-row-user' : 'msg-row-assistant'}${message.isError ? ' msg-row-error' : ''}`}
              >
                <div className="msg-meta">{message.role === 'user' ? 'You' : 'Assistant'}</div>
                <div
                  className={`bubble ${message.role === 'user' ? 'bubble-user' : 'bubble-assistant'}${message.schedule ? ' bubble-has-schedule' : ''}${message.picker ? ' bubble-embed' : ''}`}
                >
                  {body}
                </div>
              </div>
            );
          })}
          {loading && (
            <div className="msg-row msg-row-assistant">
              <div className="msg-meta">Assistant</div>
              <div className="bubble bubble-assistant bubble-typing">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            </div>
          )}
        </div>

        <form className="composer" onSubmit={onSubmitChat}>
          <input
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            // placeholder={
            //   chatMode === 'awaiting_intent'
            //     ? 'Example: create rotational schedule'
            //     : chatMode === 'awaiting_class_id'
            //       ? 'Enter class ID...'
            //       : 'Reply in natural language (names, numbers, rotations, yes/no)¦'
            // }
            className="input"
          />
          <button disabled={!canSend} type="submit" className="btn">
            {loading ? 'Sending¦' : 'Send'}
          </button>
        </form>

        {error && <p className="error">{error}</p>}

        {scheduleStepShowsGrid && displaySchedule && (
          <div className="step-panels schedule-below-chat">
            <section className="step-card schedule-card">
              <h2 className="step-title">Generated schedule</h2>
              <ScheduleGridTable schedule={displaySchedule} scrollable expandTitle="Generated schedule" />
              <footer className="schedule-save-footer">
                {savedScheduleId ? (
                  <p className="schedule-save-status">Saved to Star Academy (scheduleId: {savedScheduleId})</p>
                ) : (
                  <button
                    type="button"
                    className="btn btn-save-schedule"
                    disabled={!canSaveCurrentSchedule}
                    onClick={() => void saveCurrentSchedule(sessionId)}
                  >
                    {savingSchedule ? 'Saving…' : 'Yes, save'}
                  </button>
                )}
              </footer>
            </section>
          </div>
        )}

        {completedSchedules.map((entry, index) => (
          <div key={entry.id} className="step-panels schedule-below-chat">
            <section className="step-card schedule-card">
              <h2 className="step-title">
                Schedule {index + 1}
                {entry.classId ? ` — Class ${entry.classId}` : ''}
              </h2>
              <ScheduleGridTable
                schedule={entry.schedule}
                scrollable
                expandTitle={`Schedule ${index + 1}${entry.classId ? ` — Class ${entry.classId}` : ''}`}
              />
              <footer className="schedule-save-footer">
                {entry.savedScheduleId ? (
                  <p className="schedule-save-status">Saved (scheduleId: {entry.savedScheduleId})</p>
                ) : (
                  <button
                    type="button"
                    className="btn btn-save-schedule"
                    disabled={savingSchedule}
                    onClick={() => void saveCurrentSchedule(entry.sessionId)}
                  >
                    {savingSchedule ? 'Saving…' : 'Yes, save'}
                  </button>
                )}
              </footer>
            </section>
          </div>
        ))}

      </section>
    </main>
  );
}
