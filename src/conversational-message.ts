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
  if (isGreetingMessage(message)) {
    return buildGreetingAssistantReply(message);
  }
  return null;
}
