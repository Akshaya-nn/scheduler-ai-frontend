# Star Academy AI Scheduler — Frontend

A Vite + React + TypeScript single‑page app that provides a chat‑style interface to the **AI Rotational Scheduler** backend (`star-academy-ai-scheduler`). Users converse with the assistant to pick a class, students, a schedule type, modules, rotation count / pairing options, and finally receive a generated rotation grid.

---

## 1. Tech Stack

| Layer        | Technology                                                         |
| ------------ | ------------------------------------------------------------------ |
| Build tool   | **Vite 6**                                                         |
| Framework    | **React 18** (function components + hooks, `React.StrictMode`)     |
| Language     | **TypeScript 5.7**                                                 |
| Styling      | Plain CSS (`src/styles.css`) — no UI library, custom design tokens |
| HTTP         | Native `fetch`                                                     |
| State        | Local React state (`useState`, `useRef`, `useEffect`, `useCallback`) — no Redux / Zustand |
| API target   | `http://localhost:8080/v2/ai-rotational/*` (NestJS backend)        |

---

## 2. Project Layout

```
star-academy-ai-scheduler-fe/
├── index.html              # Vite entry, mounts <div id="root">
├── vite.config.ts          # Dev server on port 5173
├── tsconfig.json
├── tsconfig.node.json
├── package.json
└── src/
    ├── main.tsx            # ReactDOM.createRoot → <App />
    ├── App.tsx             # ALL app logic (chat, pickers, schedule grid)
    └── styles.css          # Design system (bubbles, tables, forms)
```

Everything the user sees and every network call lives inside `src/App.tsx`. There is intentionally no routing, no global store, and no component library — the flow is linear and session‑scoped.

---

## 3. Running the App

```bash
# 1. Install
npm install

# 2. Start the backend first (separate terminal)
#    cd ../star-academy-ai-scheduler && npm run start:dev
#    Backend must be reachable at http://localhost:8080

# 3. Start the frontend dev server
npm run dev              # http://localhost:5173

# Production build
npm run build            # tsc -b && vite build → dist/
npm run preview          # serve dist/
```

The API base URL is hard‑coded in `src/App.tsx`:

```ts
const apiBase = 'http://localhost:8080/v2';
```

Change this string if the backend runs elsewhere.

---

## 4. Backend Contract (what the FE talks to)

The frontend consumes **two** POST endpoints:

| Method | URL                                       | Purpose                                |
| ------ | ----------------------------------------- | -------------------------------------- |
| `POST` | `/v2/ai-rotational/session/start`         | Create a session for a given `classId` |
| `POST` | `/v2/ai-rotational/session/message`       | Send a user message into the session   |

### 4.1 Request bodies

```jsonc
// POST /session/start
{ "classId": "<uuid>", "initialMessage": "create rotational schedule" }

// POST /session/message
{ "sessionId": "<uuid>", "message": "I confirm these students…" }
```

### 4.2 Response envelope (`ApiResponse`)

The NestJS interceptor may wrap the payload under `data`; `unwrapAiRotationalPayload()` normalises it. After unwrap the FE expects:

```ts
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
  assistantMessage: string;                 // free-form text from the LLM
  students: { id: string; fullName: string }[];
  modules:  { id: string; name: string }[];
  scheduleTypes?: { id: string; name: string; type: string }[];
  selectedScheduleType?: { type: string; name: string } | null;
  selectedStudents?: { id: string; fullName: string }[];
  selectedModules?:  { id: string; name: string }[];
  schedule?: {
    seats: { 0: { id; fullName }; 1: { id; fullName } }[][];
    rowData: { moduleName: string }[];
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
```

`step` is the FE’s steering signal — it decides which picker (if any) to render next to the chat.

---

## 5. End‑to‑End Workflow

The UX is a **single chat thread** that progressively unlocks inline pickers based on `response.step`. The user can always type freely in the composer; inline pickers exist purely to make bulk selections faster.

```
                                   ┌──────────────────────────────┐
                                   │        Initial state         │
                                   │  chatMode = awaiting_intent  │
                                   └──────────────┬───────────────┘
                                                  │ user types anything
                                                  ▼
                          ┌──────────────────────────────────────────┐
                          │   isRotationalIntent(message) === true ? │
                          └───────────┬──────────────────┬───────────┘
                                   no │               yes│
                                      ▼                  ▼
                 "I can only help with     chatMode = awaiting_class_id
                  rotational schedules…"   asks: "Please provide the class ID."
                                                     │
                                                     │ user types classId
                                                     ▼
                                       POST /session/start { classId, initialMessage }
                                                     │
                                                     ▼
                                          chatMode = 'active'
                                          response.step drives the UI →
```

### 5.1 Chat modes (FE‑only, pre‑session)

`ChatMode` is local to the frontend and controls what the composer does **before** a session exists:

| `chatMode`            | Meaning                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `awaiting_intent`     | User hasn’t expressed a scheduling request yet                     |
| `awaiting_class_id`   | Intent recognised, waiting for the class UUID                      |
| `active`              | Session created — every message now goes to `/session/message`     |

Intent detection is keyword‑based (`isRotationalIntent`): `rotation, rotational, schedule, scheduler, module, students, class`.

### 5.2 Session steps (backend‑driven)

Once `active`, the backend’s `step` field drives UI affordances:

| `response.step`                         | What the FE renders                                                                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `awaiting_students`                     | Inline **numbered checkbox list** of `response.students` with a **Confirm selection** button. Assistant’s prose intro is stripped of redundant numbered lines.          |
| `awaiting_modules` (schedule‑type sub‑step) | If `modules` is empty but `scheduleTypes` are supplied → render a **radio list** of schedule types (Regular Modules / Expedition / …). One must be picked.           |
| `awaiting_modules` (content sub‑step)   | Render a **numbered checkbox list** of modules/expedition items, with a “Selected” column showing items already on the current schedule, plus a **Copy module** toggle. |
| `awaiting_rotation_count`               | No picker — user answers with a number in the chat (e.g. `3 rotations`).                                                                                                |
| `awaiting_rotation_capacity_decision`   | No picker — user answers yes/no about capacity adjustments.                                                                                                             |
| `awaiting_pairing`                      | No picker — user answers yes/no about pairing.                                                                                                                          |
| `ready_to_generate`                     | Assistant asks for confirmation to generate. User replies `yes`.                                                                                                        |
| `completed`                             | `response.schedule` is rendered as a **table** under the chat. The grid is also persisted in `persistedSchedule` so subsequent edits don’t wipe it from view.          |

### 5.3 Detailed step walk‑through

1. **Landing**
   - `chatMessages[0]` is a welcome bubble explaining the flow.
   - Composer placeholder: *"Example: create rotational schedule"*.

2. **Intent → Class ID → Session start**
   - Submitting a rotational phrase moves `chatMode` to `awaiting_class_id`.
   - Submitting the class UUID calls `startSession(classId, seedScheduleIntent)`.
   - Response is stored in `response`, `sessionId` saved, selections reset.

3. **Pick students** (`awaiting_students`)
   - `studentPickerIntroText()` extracts any human prose from `assistantMessage` while `stripNumberedListLines()` removes the LLM’s own numbered names (the UI renders its own list).
   - `confirmStudentSelection()` builds a deterministic message:
     ```
     I confirm these students for the rotation: <names>.
     Call select_students with studentIds exactly ["id1","id2",…], then continue the workflow.
     ```
     This ensures the backend’s tool‑calling pipeline invokes `select_students` with exact IDs, not fuzzy name matches.

4. **Pick schedule type** (`awaiting_modules`, content list empty)
   - A radio list (`name="schedule-type"`) is shown with schedule types the backend offers.
   - `scheduleTypeSelection` is a string id; `confirmScheduleTypeSelection()` sends the **human‑readable name** (e.g. `"Expedition"`) because the backend resolver accepts name/type aliases.
   - Retry case: `isScheduleTypeRetryMessage()` detects error phrases (`no active items available`, `please choose another schedule type`) and surfaces them as an extra assistant bubble above the picker.

5. **Pick modules / expedition items** (`awaiting_modules`, content list present)
   - Header adapts: `Module` vs `Expedition` based on `selectedScheduleType.type`.
   - Items already on the current generated schedule are marked with `Yes` in a **Selected** column so users know what to retain.
   - **Copy module** toggle (`copyEachModule`, default `true`) adds an additional row per selected module to accommodate overflow students.
   - `confirmModuleSelection()` sends a JSON **`moduleIds`** array on the request body (no stringified `[...]` in `message`). Optional `copyEachSelectedModule` / `copyModuleCount` match the DTO. The server turns that into an internal comma-separated wire for the graph.

6. **Free‑form conversational steps**
   - `awaiting_rotation_count`, `awaiting_rotation_capacity_decision`, `awaiting_pairing`, and `ready_to_generate` all use the composer only. The FE just forwards the user’s text to `/session/message`.

7. **Generate → `completed`**
   - Once the backend returns `schedule`, the FE renders it.
   - `displaySchedule = normalizedSchedule ?? (step === 'completed' ? persistedSchedule : null)` — prefers the fresh grid; falls back to the persisted one only when the step is still `completed` and the API omitted `schedule`.
   - `schedulePanelRef` scrolls the grid into view.

8. **Iterative edits**
   - Users can keep typing (e.g. *“swap student X with Y”*, *“add module Chemistry”*). Each response replaces `response`; `mergePersistedSchedule()` clears the persisted grid when the backend invalidates inputs mid‑flow, and keeps it only while `step === 'completed'`.

---

## 6. Rendering the Schedule Grid

The schedule is a 2D grid of seats. Each cell is an object with string keys `"0"` and `"1"` representing two seat slots per module/rotation.

```
┌─────────┬──────────────┬──────────────┬──────────────┐
│ Module  │ Rotation 1   │ Rotation 2   │ Rotation 3   │
├─────────┼──────────────┼──────────────┼──────────────┤
│ Math    │ Alice        │ Charlie      │ Eve          │   ← slot 0 (primary)
│         │ Bob          │ Dan          │ Frank        │   ← slot 1 (secondary)
├─────────┼──────────────┼──────────────┼──────────────┤
│ Science │ …            │ …            │ …            │
└─────────┴──────────────┴──────────────┴──────────────┘
```

Implementation details:

- Column count = `max(schedule.colCount, widest row)` via `scheduleRotationColumnCount()`.
- `getSeatSlot(cell, 0|1)` safely reads the seat name and falls back to `(empty)`.
- Each module row is rendered as **two `<tr>`s** (`student-row-primary`, `student-row-secondary`) sharing one `rowSpan={2}` module cell.
- `schedule.warnings` are surfaced in a `.warning` block above the table.

---

## 7. Chat Thread Rendering

`ChatMessage` supports three shapes:

| Shape            | Fields used                               | Example                                                   |
| ---------------- | ----------------------------------------- | --------------------------------------------------------- |
| Plain bubble     | `text`                                    | Any assistant prose or user typed text                    |
| Numbered list    | `heading`, `items`, optional `text`       | "Selected students (10)" + `<ol>` of names                |
| Pre‑formatted    | `preformatted = true`, `text` with `\| --- \|` | Markdown tables returned by the backend, kept monospace   |

Messages are split by `assistantChunksAfterResponse()`:
- Tables (contain `| --- |`) are kept as a single preformatted bubble.
- Everything else is split on blank lines (`\n{2,}`) into individual bubbles.
- For `awaiting_students` the assistant text is suppressed entirely (the picker carries the message). For `awaiting_modules` it is suppressed unless a schedule‑type retry error is present.

A typing indicator (`bubble-typing` with three dots) is shown while `loading` is true.

---

## 8. State Machine (FE)

```
sessionId: string                       ''                      set by startSession
chatMode:  ChatMode                     'awaiting_intent'       local only
response:  ApiResponse | null           null                    replaced on every API call
persistedSchedule:                      null                    last known grid
studentSelection:  string[]                                     picker state
moduleSelection:   string[]                                     picker state (hydrated from selectedModules)
scheduleTypeSelection: string                                   radio state
copyEachModule: boolean                 true
chatInput: string                       ''
loading, error: UI state
chatMessages: ChatMessage[]             [welcome]
```

Key effects:

- **Hydrate module selection** whenever `sessionId`, `step`, or `selectedModuleIds` change.
- **Reset schedule‑type radio** whenever the list of schedule types or step changes.
- **Auto‑scroll** the chat thread on every new message / loading toggle.
- **Auto‑scroll** to the schedule panel when a new `displaySchedule` arrives.

---

## 9. Error Handling

- Network / non‑2xx responses throw and are caught in `startSession` and `sendMessage`.
- Errors are:
  - Stored in `error` and rendered as a red `.error` line below the composer.
  - Appended as an assistant bubble marked `isError` (`Something went wrong: <message>`).
- The `unwrapAiRotationalPayload()` helper handles the case where Nest’s transform interceptor wraps the real payload in `{ statusCode, success, data: {...} }`.

---

## 10. Customisation Points

| Need                              | Where to change                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------- |
| Change API base URL               | `apiBase` constant in `src/App.tsx`                                             |
| Add more intent keywords          | `isRotationalIntent()` in `src/App.tsx`                                         |
| Tweak welcome message             | Initial `chatMessages` state in `App()`                                         |
| Style (colors, spacing, bubbles)  | `src/styles.css`                                                                |
| Dev port                          | `server.port` in `vite.config.ts`                                               |
| Add a new `step`                  | Extend `ApiResponse['step']` union + add a conditional block in the chat thread |

---

## 11. Full User Journey — Example

1. User opens `http://localhost:5173`.
2. Types: `create a rotational schedule` → chat prompts for class ID.
3. Types: `a4f1…uuid` → backend returns `awaiting_students` + a list of 24 students.
4. Ticks 20 students → clicks **Confirm selection** → backend replies `awaiting_modules` with `scheduleTypes = [Regular Modules, Expedition]`.
5. Selects `Regular Modules` (radio) → **Confirm** → backend replies `awaiting_modules` with the actual modules list.
6. Ticks 5 modules, leaves **Copy module** on → **Confirm** → backend replies `awaiting_rotation_count`.
7. Types: `5 rotations` → `awaiting_rotation_capacity_decision`.
8. Types: `yes` → `awaiting_pairing`.
9. Types: `no` → `ready_to_generate`.
10. Types: `yes, generate` → backend returns `completed` with a `schedule` — the grid appears below the chat, any warnings are listed above the table, and the composer remains open for further edits (`swap X with Y`, `add module Chemistry`, etc.).

---

## 12. Troubleshooting

| Symptom                                            | Likely cause                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Failed to fetch` when starting a session          | Backend not running, wrong `apiBase`, or CORS not enabled on the NestJS side.  |
| `Message failed` after picker confirmation         | Backend tool‑call rejected IDs — check that class still owns those students/modules. |
| Picker shows the same list twice                   | `stripNumberedListLines()` failed — the backend message format may have changed. |
| Schedule disappears mid‑conversation               | Expected: `mergePersistedSchedule()` clears it when step ≠ `completed`.        |
| `statusCode` / `success` keys leaking into types   | `unwrapAiRotationalPayload()` is not picking up the nested `data` — verify the Nest interceptor. |

---

## 13. Scripts Reference

```bash
npm run dev       # Vite dev server with HMR (port 5173)
npm run build     # Type-check (tsc -b) and bundle (vite build) → dist/
npm run preview   # Serve the production build locally
```

---

**Related projects in this workspace**

- `../star-academy-ai-scheduler/` — NestJS backend (the LangGraph workflow + `/v2/ai-rotational/*` endpoints).
- `../rotational-langgraph-nest/` — standalone LangGraph reference implementation.
- `../star-academy-classes/` — sample class / student / module fixtures.
