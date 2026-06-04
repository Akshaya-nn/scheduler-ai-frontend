/**
 * Lightweight greeting / thanks detection for pre-session chat (mirrors backend
 * conversational-message.ts — keep in sync when changing greeting behavior).
 */

export const GREETING_ASSISTANT_REPLY =
  "Hi! I'm AI Scheduler. How can I help you today?";

const TIME_OF_DAY_GREETING_REPLIES: ReadonlyArray<{
  pattern: RegExp;
  reply: string;
}> = [
  {
    pattern: /\bgood morning\b/,
    reply:
      "Good morning! I'm AI Scheduler. How can I help you today?",
  },
  {
    pattern: /\bgood afternoon\b/,
    reply:
      "Good afternoon! I'm AI Scheduler. How can I help you today?",
  },
  {
    pattern: /\bgood evening\b/,
    reply:
      "Good evening! I'm AI Scheduler. How can I help you today?",
  },
  {
    pattern: /\bgood night\b/,
    reply: "Good night! I'm AI Scheduler. How can I help you today?",
  },
  {
    pattern: /\bgood day\b/,
    reply: "Good day! I'm AI Scheduler. How can I help you today?",
  },
];

export const THANK_YOU_ASSISTANT_REPLY = "You're welcome!";

/** Keep in sync with backend conversational-message.ts */
export const USAGE_HELP_ASSISTANT_REPLY =
  'I am the AI Rotational Scheduler. I help you build and update class rotation grids using chat and the panels under each message.\n\n' +
  'How it works:\n' +
  '1. Select a schedule type using the list in chat, then tap Confirm selection. You can also reply with the name or number.\n' +
  '2. Next you will see the modules for that type. Choose the modules you want and confirm. All students in the class are selected at first; you can change the student list later if needed.\n' +
  '3. To edit an existing schedule, tell me what to add, remove, delete, or update (students, modules, rotations, copy rows). I will regenerate the grid to match.\n' +
  '4. When you are satisfied, save the schedule from the UI to apply it to your class.\n\n' +
  'The student list, module catalog, and schedule table are shown in the panels below the chat so you usually pick there instead of typing long lists.';

const USAGE_HELP_PATTERNS: RegExp[] = [
  /\bhow\s+(?:do|can|does|to)\s+(?:(?:i|we|you)\s+)?use\b/,
  /\bhow\s+to\s+use\b/,
  /\bhow\s+(?:do|can)\s+(?:i|we)\s+(?:get\s+started|begin|start)\b/,
  /\bhow\s+(?:does|do)\s+(?:this|the|it)\s+(?:ai\s+)?(?:scheduler|schedular)?\b/,
  /\bhow\s+(?:does|do)\s+(?:this|it)\s+(?:ai\s+)?work\b/,
  /\bwhat\s+can\s+(?:you|this|the\s+ai)\s+do\b/,
  /\bwhat\s+is\s+this\s+(?:ai\s+)?(?:scheduler|schedular)\b/,
  /\bhelp\s+me\s+(?:use|understand|with)\b/,
  /\b(?:guide|tutorial|instructions|getting\s+started)\b/,
  /\bexplain\s+(?:how|what|this)\b/,
  /\btell\s+me\s+how\b/,
];

export function isUsageHelpMessage(message: string): boolean {
  const normalized = normalizeConversationalMessage(message);
  if (!normalized) {
    return false;
  }
  if (/\b(?:remove|drop|delete|add|include|generate|build|make)\b/.test(normalized)) {
    return false;
  }
  if (/\b(?:first|last)\s+\d+\b/.test(normalized)) {
    return false;
  }
  if (USAGE_HELP_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (
    /\bhow\b/.test(normalized) &&
    /\b(?:use|works?|work)\b/.test(normalized) &&
    /\b(?:ai|scheduler|schedular|this)\b/.test(normalized)
  ) {
    return true;
  }
  return false;
}

export function normalizeConversationalMessage(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PURE_GREETING =
  /^(?:hi+|hello+|hey+|hiya|howdy|greetings|yo+|sup|hola|heya|how are you|how r u|good (?:morning|afternoon|evening|night|day)|what s up|whats up)(?: there)?(?: buddy| friend)?$/;

const GREETING_FRAGMENTS = [
  'good morning',
  'good afternoon',
  'good evening',
  'good night',
  'good day',
  'how are you',
  'how r u',
  'what s up',
  'whats up',
  'greetings',
  'hello',
  'hiya',
  'howdy',
  'heya',
  'hola',
  'hiii',
  'hii',
  'hi',
  'hey',
  'yo',
  'sup',
  'there',
  'buddy',
  'friend',
  'morning',
  'afternoon',
  'evening',
  'night',
  'day',
  'good',
] as const;

function stripGreetingFragments(normalized: string): string {
  let remainder = ` ${normalized} `;
  for (const fragment of GREETING_FRAGMENTS) {
    const re = new RegExp(`\\s${fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'g');
    remainder = remainder.replace(re, ' ');
  }
  return remainder.replace(/\s+/g, ' ').trim();
}

const PURE_THANK_YOU =
  /^(?:thank you|thanks|thank u|thankyou|thx|ty|much appreciated|appreciate it|appreciated)(?: so much| a lot| very much)?$/;

export function isGreetingMessage(message: string): boolean {
  const normalized = normalizeConversationalMessage(message);
  if (!normalized) {
    return false;
  }
  if (PURE_GREETING.test(normalized)) {
    return true;
  }
  return stripGreetingFragments(normalized).length === 0;
}

export function isThankYouMessage(message: string): boolean {
  const normalized = normalizeConversationalMessage(message);
  if (!normalized) {
    return false;
  }
  return PURE_THANK_YOU.test(normalized);
}

export function buildGreetingAssistantReply(message: string): string {
  const normalized = normalizeConversationalMessage(message);
  for (const { pattern, reply } of TIME_OF_DAY_GREETING_REPLIES) {
    if (pattern.test(normalized)) {
      return reply;
    }
  }
  return GREETING_ASSISTANT_REPLY;
}

export function resolveConversationalReply(message: string): string | null {
  if (isThankYouMessage(message)) {
    return THANK_YOU_ASSISTANT_REPLY;
  }
  if (isUsageHelpMessage(message)) {
    return USAGE_HELP_ASSISTANT_REPLY;
  }
  if (isGreetingMessage(message)) {
    return buildGreetingAssistantReply(message);
  }
  return null;
}
