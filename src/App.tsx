import { FormEvent, Fragment, useCallback, useEffect, useRef, useState } from 'react';

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

/** Public API `step` — what the client should show next (matches server `SelectionStep`). */
type ResponseStep =
  | 'schedule_types'
  | 'modules'
  | 'students'
  | 'rotation_range'
  | 'rotation_count'
  | 'plan'
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
  const selectedModules = i.selectedModules !== undefined
    ? i.selectedModules
    : scheduleTypeListActive
      ? []
      : (prev?.selectedModules ?? []);
  return {
    statusCode: i.statusCode ?? prev?.statusCode,
    success: i.success ?? prev?.success,
    sessionId: (i.sessionId ?? prev?.sessionId ?? '') as string,
    step: (i.step ?? prev?.step ?? 'generic') as ApiResponse['step'],
    assistantMessage: (i.assistantMessage ?? prev?.assistantMessage ?? '') as string,
    rotationRangeMax: i.rotationRangeMax !== undefined ? i.rotationRangeMax : prev?.rotationRangeMax,
    students,
    modules,
    scheduleTypes: i.scheduleTypes !== undefined ? i.scheduleTypes : prev?.scheduleTypes,
    selectedScheduleType:
      i.selectedScheduleType !== undefined ? i.selectedScheduleType : prev?.selectedScheduleType,
    selectedStudents:
      i.selectedStudents !== undefined ? i.selectedStudents : (prev?.selectedStudents ?? students),
    selectedModules,
    schedule: i.schedule !== undefined ? i.schedule : (prev?.schedule ?? null),
    config: i.config !== undefined ? i.config : prev?.config,
  };
}

const apiBase = 'http://localhost:8080/v2';

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
 * user → assistant → user, not several user rows with no visible reply.
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
      `${preselectedModuleCount} item${preselectedModuleCount === 1 ? '' : 's'} marked Selected are already on your current schedule—keep them checked to retain them, tick more to add, then confirm.`,
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

/** Split the model reply into chat bubbles; backend is the single source of truth (OpenAI + tools). */
function assistantChunksAfterResponse(data: ApiResponse): string[] {
  if (data.step === 'students') {
    return [];
  }
  if (data.step === 'modules' || data.step === 'schedule_types') {
    const rawAwaitingModules = (data.assistantMessage ?? '').trim();
    if (isAwaitingModulesTimelineAssistantSurface(rawAwaitingModules)) {
      return [stripNumberedListLines(rawAwaitingModules)];
    }
    return [];
  }
  if (data.step === 'rotation_range') {
    return [];
  }
  if (data.step === 'plan') {
    const planText = (data.assistantMessage ?? '').trim();
    return planText ? [planText] : ['…'];
  }
  const raw = (data.assistantMessage ?? '').trim();
  if (!raw) {
    return ['…'];
  }
  if (raw.includes('| --- |')) {
    return [raw];
  }
  if (/^Here's the plan based on your selection:/i.test(raw)) {
    return [raw];
  }
  const parts = raw
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return parts.length > 0 ? parts : [raw];
}

function nonEmptyChunks(chunks: string[]): string[] {
  return chunks.map((c) => c.trim()).filter((c) => c.length > 0);
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
  if (data.step === 'completed' || data.step === 'modules' || data.step === 'schedule_types' || data.step === 'students') {
    return previous;
  }
  return null;
}

/** Copy rows expand `selectedModules` with synthetic suffixes; checklist rows use catalog ids. */
function catalogIdFromExpandedModuleRowId(id: string): string {
  return id.replace(/::__copy_\d+(?:_\d+)?$/i, '');
}

function ScheduleGridTable({ schedule }: { schedule: NonNullable<ApiResponse['schedule']> }) {
  const rotationCols = scheduleRotationColumnCount(schedule);
  const orderedRows = scheduleRowDisplayOrder(schedule);
  return (
    <div className="schedule-table-wrap">
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
    </div>
  );
}

type CompletedScheduleEntry = {
  id: string;
  classId: string;
  schedule: NonNullable<ApiResponse['schedule']>;
  generatedAt: number;
};

export default function App() {
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
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: nextMessageId(),
      role: 'assistant',
      text: 'Hello! I’m your AI Assistant for creating smart rotational schedules.',
    },
  ]);

  const chatThreadRef = useRef<HTMLDivElement>(null);
  const schedulePanelRef = useRef<HTMLDivElement>(null);
  /** Track last completed schedule snapshot that triggered auto-scroll to the grid. */
  const lastScrolledScheduleFingerprintRef = useRef<string | null>(null);
  /** True once the user has reached `completed` with a grid — used to skip chat auto-scroll during module-edit interrupts. */
  const completedScheduleEverRef = useRef(false);
  /** Avoid double `scrollIntoView` in React Strict Mode for the same bubble. */
  const moduleCapacityScrollDoneForMessageIdRef = useRef<string | null>(null);

  const appendMessages = useCallback((entries: Omit<ChatMessage, 'id'>[]) => {
    setChatMessages((prev) => [...prev, ...entries.map((e) => ({ ...e, id: nextMessageId() }))]);
  }, []);

  useEffect(() => {
    lastScrolledScheduleFingerprintRef.current = null;
    completedScheduleEverRef.current = false;
  }, [sessionId]);

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
    if (!response || response.step !== 'rotation_range') {
      return;
    }
    const finalRot = Math.max(
      2,
      response.rotationRangeMax ?? response.config?.endRotation ?? response.schedule?.colCount ?? 2,
    );
    let curStart = response.config?.startRotation ?? 1;
    let curEnd = response.config?.endRotation ?? finalRot;
    if (curStart < 1 || curStart >= finalRot) {
      curStart = 1;
    }
    if (curEnd <= curStart || curEnd > finalRot) {
      curEnd = finalRot;
    }
    setStartRotationSelection(String(curStart));
    setEndRotationSelection(String(curEnd));
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
    response?.step === 'rotation_range'
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

  /**
   * Scroll to the generated schedule when a newly completed/updated grid is received.
   * Plain chat messages should stay within the chat thread without yanking the page.
   */
  useEffect(() => {
    if (!response || response.sessionId !== sessionId) {
      return;
    }
    if (response.step !== 'completed') {
      return;
    }
    const grid = normalizedSchedule;
    if (!grid) {
      return;
    }
    const fingerprint = scheduleFingerprint(grid);
    if (lastScrolledScheduleFingerprintRef.current === fingerprint) {
      return;
    }
    lastScrolledScheduleFingerprintRef.current = fingerprint;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        schedulePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
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

  async function startSession(classId: string) {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/ai-rotational/session/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classId }),
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
      appendMessages(
        nonEmptyChunks(assistantChunksAfterResponse(data)).map((text) => ({ role: 'assistant' as const, text })),
      );
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
      appendMessages(
        nonEmptyChunks(assistantChunksAfterResponse(merged)).map((text) => ({
          role: 'assistant' as const,
          text,
          preformatted: text.includes('| --- |'),
        })),
      );
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
          classId: currentClassId,
          schedule,
          generatedAt: Date.now(),
        },
      ]);
    }
    setSessionId('');
    setCurrentClassId('');
    setResponse(null);
    setPersistedSchedule(null);
    setStudentSelection([]);
    setModuleSelection([]);
    setScheduleTypeSelection('');
    setCopyEachModule(false);
    setCopyModuleCount('1');
    setError('');
    setChatMode('awaiting_class_id');
    lastScrolledScheduleFingerprintRef.current = null;
    completedScheduleEverRef.current = false;
    moduleCapacityScrollDoneForMessageIdRef.current = null;
    appendMessages([
      {
        role: 'assistant',
        text: "Sure — let's create another rotational schedule. Please provide the new class ID.",
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
    appendMessages([{ role: 'user', text: message }]);

    /**
     * After a schedule is generated, accept "create new schedule" / "another schedule" /
     * "new rotational schedule" as a shortcut that resets the session and asks for a fresh class ID.
     * Inline class IDs in the same message are honored so the user can skip the prompt.
     */
    if (sessionId && response?.step === 'completed' && isCreateNewScheduleIntent(message)) {
      const inlineClassId = extractClassIdFromMessage(message);
      const handled = archiveCurrentScheduleAndResetForNewFlow(message);
      if (handled && inlineClassId) {
        await startSession(inlineClassId);
      }
      return;
    }

    if (!sessionId) {
      if (chatMode === 'awaiting_intent') {
        /**
         * Accept a bare Mongo ObjectId (or message that contains one) before
         * requiring rotational phrasing — matches "paste class ID only" UX.
         */
        const inlineClassIdEarly = extractClassIdFromMessage(message);
        if (inlineClassIdEarly) {
          await startSession(inlineClassIdEarly);
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
      await startSession(inlineClassId);
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
    appendMessages([
      {
        role: 'user',
        heading: `Selected students (${studentSelection.length})`,
        items: names,
      },
    ]);
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
    appendMessages([
      {
        role: 'user',
        heading: 'Selected schedule type',
        items: [picked.name],
      },
    ]);
    /** Send the human-readable name; backend resolver matches on name/type alias. */
    await sendMessage(picked.name);
  }

  async function confirmModuleSelection() {
    if (!response || response.step !== 'modules') return;
    if (loading) return;
    if (moduleSelection.length === 0) return;
    const names = moduleSelection
      .map((id) => response.modules.find((m) => m.id === id)?.name ?? id)
      .filter(Boolean);
    appendMessages([
      {
        role: 'user',
        heading: `Selected modules (${moduleSelection.length})`,
        items: names,
      },
    ]);
    const parsedCopyCount = Number.parseInt(copyModuleCount, 10);
    const normalizedCopyCount = Number.isInteger(parsedCopyCount) && parsedCopyCount > 0 ? parsedCopyCount : 1;
    const payload: SessionModuleIdsPayload = { moduleIds: [...moduleSelection] };
    if (copyEachModule) {
      payload.copyEachSelectedModule = true;
      payload.copyModuleCount = normalizedCopyCount;
    }
    await sendMessage(payload);
  }

  function rotationRangeValid(
    start: number,
    end: number,
    finalRot: number,
  ): boolean {
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (start < 1 || start >= finalRot) return false;
    if (end <= start || end > finalRot) return false;
    return true;
  }

  async function confirmRotationRangeSelection() {
    if (!response || response.step !== 'rotation_range') return;
    if (loading) return;
    const finalRot = Math.max(
      2,
      response.rotationRangeMax ?? response.config?.endRotation ?? response.schedule?.colCount ?? 2,
    );
    const start = Number.parseInt(startRotationSelection, 10);
    const end = Number.parseInt(endRotationSelection, 10);
    if (!rotationRangeValid(start, end, finalRot)) return;

    appendMessages([
      {
        role: 'user',
        heading: 'Selected rotation range',
        items: [`Start rotation: ${start}`, `End rotation: ${end}`],
      },
    ]);
    await sendMessage(`start rotation exactly ${start} end rotation exactly ${end}`);
  }

  function renderMessageBody(message: ChatMessage) {
    if (message.role === 'user' && (message.heading || (message.items && message.items.length > 0))) {
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
    if (message.preformatted && message.text) {
      return <pre className="bubble-text bubble-pre-table">{message.text}</pre>;
    }
    return <p className="bubble-text">{message.text}</p>;
  }

  return (
    <main className="page">
      <section className="card">
        <h1>AI Rotational Scheduler</h1>

        <div ref={chatThreadRef} className="chat-thread" role="log" aria-live="polite">
          {chatMessages.map((message) => (
            <div
              key={message.id}
              id={`chat-msg-${message.id}`}
              className={`msg-row ${message.role === 'user' ? 'msg-row-user' : 'msg-row-assistant'}${message.isError ? ' msg-row-error' : ''}`}
            >
              <div className="msg-meta">{message.role === 'user' ? 'You' : 'Assistant'}</div>
              <div className={`bubble ${message.role === 'user' ? 'bubble-user' : 'bubble-assistant'}`}>
                {renderMessageBody(message)}
              </div>
            </div>
          ))}
          {response?.step === 'students' && (
            <div className="msg-row msg-row-assistant">
              <div className="msg-meta">Assistant</div>
              <div className="bubble bubble-assistant bubble-embed bubble-embed-unified">
                {studentPickerIntroText(response.assistantMessage).map((para, i) => (
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
                <label className="inline-pick-row inline-pick-row-numbered inline-pick-row-modules">
                  <span className="inline-pick-number" aria-hidden>
                    0.
                  </span>
                  <input
                    type="checkbox"
                    checked={
                      response.students.length > 0 &&
                      response.students.every((student) => studentSelection.includes(student.id))
                    }
                    onChange={() =>
                      toggleAllIds(
                        response.students.map((student) => student.id),
                        studentSelection,
                        setStudentSelection,
                      )
                    }
                  />
                  <span className="inline-pick-name">Select all students</span>
                  <span className="inline-pick-selected-cell">
                    {response.students.length > 0 &&
                    response.students.every((student) => studentSelection.includes(student.id)) ? (
                      <span className="inline-pick-selected-yes" title="All students selected">
                        Yes
                      </span>
                    ) : (
                      <span className="inline-pick-selected-dash">—</span>
                    )}
                  </span>
                </label>
                <ul className="inline-pick-list inline-pick-list-numbered" aria-label="Students — tick to include">
                  {response.students.map((student, index) => {
                    const selected = studentSelection.includes(student.id);
                    return (
                      <li key={student.id}>
                        <label className="inline-pick-row inline-pick-row-numbered inline-pick-row-modules">
                          <span className="inline-pick-number" aria-hidden>
                            {index + 1}.
                          </span>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleId(student.id, studentSelection, setStudentSelection)}
                          />
                          <span className="inline-pick-name">{student.fullName}</span>
                          <span className="inline-pick-selected-cell">
                            {selected ? (
                              <span className="inline-pick-selected-yes" title="Currently selected">
                                Yes
                              </span>
                            ) : (
                              <span className="inline-pick-selected-dash">—</span>
                            )}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <div className="bubble-actions">
                  <button
                    className="btn primary"
                    type="button"
                    disabled={loading || studentSelection.length === 0}
                    onClick={confirmStudentSelection}
                  >
                    Confirm selection
                  </button>
                </div>
              </div>
            </div>
          )}
          {response && (response.step === 'schedule_types' || response.step === 'modules') && (
            <div className="msg-row msg-row-assistant">
              <div className="msg-meta">Assistant</div>
              <div className="bubble bubble-assistant bubble-embed bubble-embed-unified">
                {response.step === 'schedule_types'
                  ? scheduleTypePickerIntroText(response.assistantMessage).map((para, i) => (
                      <p key={i} className="bubble-text bubble-text-tight">
                        {para}
                      </p>
                    ))
                  : modulePickerIntroText(
                      response.assistantMessage,
                      response.selectedModules?.length ?? 0,
                      (response.modules?.length ?? 0) > 0,
                    ).map((para, i) => (
                      <p key={i} className="bubble-text bubble-text-tight">
                        {para}
                      </p>
                    ))}
                {response.step === 'schedule_types' && (
                  <>
                    <div className="inline-pick-head" aria-hidden>
                      <span className="inline-pick-head-num">#</span>
                      <span className="inline-pick-head-ch"> </span>
                      <span className="inline-pick-head-name">Schedule type</span>
                    </div>
                    <ul
                      className="inline-pick-list inline-pick-list-numbered"
                      aria-label="Schedule types — pick one"
                    >
                      {(response.scheduleTypes ?? []).map((item, index) => (
                        <li key={item.id}>
                          <label className="inline-pick-row inline-pick-row-numbered inline-pick-row-modules">
                            <span className="inline-pick-number" aria-hidden>
                              {index + 1}.
                            </span>
                            <input
                              type="radio"
                              name="schedule-type"
                              checked={scheduleTypeSelection === item.id}
                              onChange={() => setScheduleTypeSelection(item.id)}
                            />
                            <span className="inline-pick-name">{item.name}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                    <div className="bubble-actions">
                      <button
                        className="btn primary"
                        type="button"
                        disabled={loading || !scheduleTypeSelection}
                        onClick={confirmScheduleTypeSelection}
                      >
                        Confirm selection
                      </button>
                    </div>
                  </>
                )}
                {response.step === 'modules' && (
                  <>
                    <div className="inline-pick-head" aria-hidden>
                      <span className="inline-pick-head-num">#</span>
                      <span className="inline-pick-head-ch"> </span>
                      <span className="inline-pick-head-name">
                        {response.selectedScheduleType?.type === 'expedition' ? 'Expedition' : 'Module'}
                      </span>
                      <span className="inline-pick-head-selected">Selected</span>
                    </div>
                    <label className="inline-pick-row inline-pick-row-numbered inline-pick-row-modules">
                      <span className="inline-pick-number" aria-hidden>
                        0.
                      </span>
                      <input
                        type="checkbox"
                        checked={response.modules.length > 0 && response.modules.every((m) => moduleSelection.includes(m.id))}
                        onChange={() =>
                          toggleAllIds(
                            response.modules.map((m) => m.id),
                            moduleSelection,
                            setModuleSelection,
                          )
                        }
                      />
                      <span className="inline-pick-name">
                        Select all {response.selectedScheduleType?.type === 'expedition' ? 'expeditions' : 'modules'}
                      </span>
                      <span className="inline-pick-selected-cell">
                        {response.modules.length > 0 && response.modules.every((m) => moduleSelection.includes(m.id)) ? (
                          <span className="inline-pick-selected-yes" title="All items selected">
                            Yes
                          </span>
                        ) : (
                          <span className="inline-pick-selected-dash">—</span>
                        )}
                      </span>
                    </label>
                    <ul className="inline-pick-list inline-pick-list-numbered" aria-label="Items — tick to include">
                      {response.modules.map((moduleItem, index) => {
                        const onCurrentSchedule = (response.selectedModules ?? []).some(
                          (m) => catalogIdFromExpandedModuleRowId(m.id) === moduleItem.id,
                        );
                        return (
                          <li key={moduleItem.id}>
                            <label className="inline-pick-row inline-pick-row-numbered inline-pick-row-modules">
                              <span className="inline-pick-number" aria-hidden>
                                {index + 1}.
                              </span>
                              <input
                                type="checkbox"
                                checked={moduleSelection.includes(moduleItem.id)}
                                onChange={() => toggleId(moduleItem.id, moduleSelection, setModuleSelection)}
                              />
                              <span className="inline-pick-name">{moduleItem.name}</span>
                              <span className="inline-pick-selected-cell">
                                {onCurrentSchedule ? (
                                  <span className="inline-pick-selected-yes" title="Already on your generated schedule">
                                    Yes
                                  </span>
                                ) : (
                                  <span className="inline-pick-selected-dash">—</span>
                                )}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                    <label className="inline-pick-row copy-module-option">
                      <input
                        type="checkbox"
                        checked={copyEachModule}
                        onChange={(event) => setCopyEachModule(event.target.checked)}
                        disabled={loading}
                      />
                      <span>Copy module — Select if you need a copy module</span>
                    </label>
                    <label className="copy-module-count" htmlFor="copy-module-count">
                      <span>Enter copy module</span>
                      <input
                        id="copy-module-count"
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
                        disabled={loading || !copyEachModule}
                      />
                    </label>
                    <div className="bubble-actions">
                      <button
                        className="btn primary"
                        type="button"
                        disabled={
                          loading ||
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
              </div>
            </div>
          )}
          {response?.step === 'rotation_range' && (
            <div className="msg-row msg-row-assistant">
              <div className="msg-meta">Assistant</div>
              <div className="bubble bubble-assistant bubble-embed bubble-embed-unified">
                <p className="bubble-text bubble-text-tight">
                  Select the start and end rotation count to update, then confirm.
                </p>
                <label className="copy-module-count" htmlFor="start-rotation-range">
                  <span>Start rotation</span>
                  <input
                    id="start-rotation-range"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={Math.max(
                      1,
                      (response.rotationRangeMax ?? response.config?.endRotation ?? 2) - 1,
                    )}
                    step={1}
                    value={startRotationSelection}
                    onChange={(event) => {
                      const raw = event.target.value;
                      if (raw === '' || /^\d+$/.test(raw)) {
                        setStartRotationSelection(raw);
                      }
                    }}
                    disabled={loading}
                  />
                </label>
                <label className="copy-module-count" htmlFor="end-rotation-range">
                  <span>End rotation</span>
                  <input
                    id="end-rotation-range"
                    type="number"
                    inputMode="numeric"
                    min={2}
                    max={response.rotationRangeMax ?? response.config?.endRotation ?? 99}
                    step={1}
                    value={endRotationSelection}
                    onChange={(event) => {
                      const raw = event.target.value;
                      if (raw === '' || /^\d+$/.test(raw)) {
                        setEndRotationSelection(raw);
                      }
                    }}
                    disabled={loading}
                  />
                </label>
                <div className="bubble-actions">
                  <button
                    className="btn primary"
                    type="button"
                    disabled={
                      loading ||
                      !response ||
                      (() => {
                        const finalRot = Math.max(
                          2,
                          response.rotationRangeMax ?? response.config?.endRotation ?? 2,
                        );
                        const s = Number.parseInt(startRotationSelection, 10);
                        const e = Number.parseInt(endRotationSelection, 10);
                        return !rotationRangeValid(s, e, finalRot);
                      })()
                    }
                    onClick={confirmRotationRangeSelection}
                  >
                    Confirm rotation range
                  </button>
                </div>
              </div>
            </div>
          )}
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
            placeholder={
              chatMode === 'awaiting_intent'
                ? 'Example: create rotational schedule'
                : chatMode === 'awaiting_class_id'
                  ? 'Enter class ID...'
                  : 'Reply in natural language (names, numbers, rotations, yes/no)…'
            }
            className="input"
          />
          <button disabled={!canSend} type="submit" className="btn">
            {loading ? 'Sending…' : 'Send'}
          </button>
        </form>

        {error && <p className="error">{error}</p>}

        {completedSchedules.map((entry, index) => (
          <div key={entry.id} className="step-panels schedule-below-chat">
            <section className="step-card">
              <h2 className="step-title">
                Schedule {index + 1}
                {entry.classId ? ` — Class ${entry.classId}` : ''}
              </h2>
              <ScheduleGridTable schedule={entry.schedule} />
            </section>
          </div>
        ))}

        {displaySchedule && (
          <div ref={schedulePanelRef} className="step-panels schedule-below-chat">
            <section className="step-card">
              <h2 className="step-title">
                {completedSchedules.length > 0
                  ? `Schedule ${completedSchedules.length + 1}${currentClassId ? ` — Class ${currentClassId}` : ''}`
                  : 'Generated schedule'}
              </h2>
              <ScheduleGridTable schedule={displaySchedule} />
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
