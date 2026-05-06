import { FormEvent, Fragment, useCallback, useEffect, useRef, useState } from 'react';

function toggleId(id: string, list: string[], setter: (next: string[]) => void) {
  if (list.includes(id)) {
    setter(list.filter((item) => item !== id));
    return;
  }
  setter([...list, id]);
}

type Student = { id: string; fullName: string };
type ModuleItem = { id: string; name: string };
type ScheduleTypeItem = { id: string; name: string; type: string };
type SeatCell = { 0: { id: string; fullName: string }; 1: { id: string; fullName: string } };

type ApiResponse = {
  sessionId: string;
  step:
    | 'awaiting_students'
    | 'awaiting_modules'
    | 'awaiting_rotation_count'
    | 'awaiting_rotation_capacity_decision'
    | 'awaiting_pairing'
    | 'ready_to_generate'
    | 'completed';
  assistantMessage: string;
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
  return (
    /\b(module\s*type|schedule\s*type|content\s*type|kind\s+of\s+rotational\s+schedule)\b/i.test(raw) &&
    /^\s*\d+\s*[\.\)]\s*\S/m.test(raw)
  );
}

/** True when schedule-type response includes an error/retry explanation. */
function isScheduleTypeRetryMessage(assistantMessage: string): boolean {
  const raw = (assistantMessage ?? '').trim();
  return (
    /\b(could not match|no active items available|please choose another schedule type|select one from the list)\b/i.test(
      raw,
    ) && isScheduleTypePrompt(raw)
  );
}

/**
 * When step is awaiting_modules, most assistant text is only shown inside the inline picker.
 * Capacity / validation replies must also appear as timeline bubbles so the flow reads
 * user → assistant → user, not several user rows with no visible reply.
 */
function isAwaitingModulesTimelineAssistantSurface(raw: string): boolean {
  const t = (raw ?? '').trim();
  if (!t) return false;
  if (isScheduleTypeRetryMessage(t)) return true;
  if (/^great\b/i.test(t) && /\bhere are the\b/i.test(t)) return false;
  if (/\bwhich kind of rotational schedule\b/i.test(t)) return false;
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
  if (data.step === 'awaiting_students') {
    return [];
  }
  if (data.step === 'awaiting_modules') {
    const rawAwaitingModules = (data.assistantMessage ?? '').trim();
    if (isAwaitingModulesTimelineAssistantSurface(rawAwaitingModules)) {
      return [stripNumberedListLines(rawAwaitingModules)];
    }
    return [];
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
  if (data.step === 'completed' || data.step === 'awaiting_modules' || data.step === 'awaiting_students') {
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
  const [seedScheduleIntent, setSeedScheduleIntent] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  /** Keeps the last generated grid if a later API message omits `schedule`. */
  const [persistedSchedule, setPersistedSchedule] = useState<ApiResponse['schedule'] | null>(null);
  const [studentSelection, setStudentSelection] = useState<string[]>([]);
  const [moduleSelection, setModuleSelection] = useState<string[]>([]);
  const [scheduleTypeSelection, setScheduleTypeSelection] = useState<string>('');
  const [copyEachModule, setCopyEachModule] = useState(false);
  const [copyModuleCount, setCopyModuleCount] = useState('1');
  const [error, setError] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: nextMessageId(),
      role: 'assistant',
      text: 'Hello! Ask to create a rotational schedule, then enter your class ID. ',
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
      response?.step === 'awaiting_modules' &&
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
     * After a schedule exists, reopening modules (`awaiting_modules`) appends assistant text + inline picker.
     * Scrolling `threadEndRef` into view walks scroll parents and often yanks the **page** down to the
     * schedule below the composer. Skip that auto-scroll during this interrupt; user stays on the chat/picker.
     */
    if (
      (response?.step === 'awaiting_modules' || response?.step === 'awaiting_students') &&
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
    if (response?.step !== 'awaiting_modules') {
      return;
    }
    const ids = [...new Set((response.selectedModules ?? []).map((m) => catalogIdFromExpandedModuleRowId(m.id)))];
    setModuleSelection(ids);
  }, [response?.sessionId, response?.step, selectedModuleIdsSig]);

  const selectedStudentIdsSig = (response?.selectedStudents ?? []).map((s) => s.id).join('|');
  useEffect(() => {
    if (response?.step !== 'awaiting_students') {
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

  const normalizedSchedule = response ? pickScheduleFromPayload(response) : null;
  /** Keep showing the last grid when reopening module/student pick after `completed` (API may omit `schedule` on interrupt steps). */
  const displaySchedule =
    normalizedSchedule ??
    (response?.step === 'completed' ||
    response?.step === 'awaiting_modules' ||
    response?.step === 'awaiting_students'
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

  async function startSession(classId: string, initialIntent?: string) {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/ai-rotational/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classId, initialMessage: initialIntent?.trim() || undefined }),
      });
      const raw = (await res.json()) as Record<string, unknown>;
      const data = unwrapAiRotationalPayload(raw) as ApiResponse;
      if (!res.ok) {
        throw new Error((data as unknown as { message?: string })?.message ?? 'Failed to start session');
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

  async function sendMessage(message: string) {
    const activeSessionId = sessionId;
    if (!activeSessionId) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/ai-rotational/session/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId, message }),
      });
      const raw = (await res.json()) as Record<string, unknown>;
      const data = unwrapAiRotationalPayload(raw) as ApiResponse;
      if (!res.ok) {
        throw new Error((data as unknown as { message?: string })?.message ?? 'Message failed');
      }
      setResponse(data);
      setPersistedSchedule((prev) => mergePersistedSchedule(data, prev));
      appendMessages(
        nonEmptyChunks(assistantChunksAfterResponse(data)).map((text) => ({
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
    setSeedScheduleIntent(triggerMessage);
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
        setSeedScheduleIntent('');
        await startSession(inlineClassId, message);
      }
      return;
    }

    if (!sessionId) {
      if (chatMode === 'awaiting_intent') {
        if (!isRotationalIntent(message)) {
          appendMessages([
            {
              role: 'assistant',
              text: 'I can help with rotational schedule creation. Please ask to create a rotational schedule.',
            },
          ]);
          return;
        }
        const inlineClassId = extractClassIdFromMessage(message);
        if (inlineClassId) {
          setSeedScheduleIntent('');
          await startSession(inlineClassId, message);
          return;
        }
        setSeedScheduleIntent(message);
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
      const remainingIntent = message.replace(inlineClassId, ' ').replace(/\s+/g, ' ').trim();
      const composedIntent = [seedScheduleIntent.trim(), remainingIntent].filter((part) => part.length > 0).join('. ');
      await startSession(inlineClassId, composedIntent || undefined);
      setSeedScheduleIntent('');
      return;
    }
    await sendMessage(message);
  }

  async function confirmStudentSelection() {
    if (!response || response.step !== 'awaiting_students') return;
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
    if (!response || response.step !== 'awaiting_modules') return;
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
    if (!response || response.step !== 'awaiting_modules') return;
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
    const idsJson = JSON.stringify(moduleSelection);
    const parsedCopyCount = Number.parseInt(copyModuleCount, 10);
    const normalizedCopyCount = Number.isInteger(parsedCopyCount) && parsedCopyCount > 0 ? parsedCopyCount : 1;
    const copyPart = copyEachModule
      ? ` copyEachSelectedModule: true. copyModuleCount: ${normalizedCopyCount}.`
      : '';
    await sendMessage(
      `I confirm these modules for the rotation: ${names.join(', ')}. Call select_modules with moduleIds exactly ${idsJson}.${copyPart} Then continue the workflow.`,
    );
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
          {response?.step === 'awaiting_students' && (
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
          {response?.step === 'awaiting_modules' && (
            <div className="msg-row msg-row-assistant">
              <div className="msg-meta">Assistant</div>
              <div className="bubble bubble-assistant bubble-embed bubble-embed-unified">
                {modulePickerIntroText(
                  response.assistantMessage,
                  response.selectedModules?.length ?? 0,
                  (response.modules?.length ?? 0) > 0,
                ).map((para, i) => (
                  <p key={i} className="bubble-text bubble-text-tight">
                    {para}
                  </p>
                ))}
                {(response.modules?.length ?? 0) === 0 && (response.scheduleTypes?.length ?? 0) > 0 && (
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
                {(response.modules?.length ?? 0) > 0 && (
                  <>
                    <div className="inline-pick-head" aria-hidden>
                      <span className="inline-pick-head-num">#</span>
                      <span className="inline-pick-head-ch"> </span>
                      <span className="inline-pick-head-name">
                        {response.selectedScheduleType?.type === 'expedition' ? 'Expedition' : 'Module'}
                      </span>
                      <span className="inline-pick-head-selected">Selected</span>
                    </div>
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
