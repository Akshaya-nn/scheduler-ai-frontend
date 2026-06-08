const apiBase = import.meta.env.VITE_AI_API_BASE ?? 'http://localhost:8080/v2';

export type SessionHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
};

export type SessionHistoryResponse = {
  statusCode?: number;
  success?: boolean;
  sessionId: string;
  source: 'memory' | 'database';
  messages: SessionHistoryMessage[];
  message?: string;
};

function unwrapHistoryPayload(raw: Record<string, unknown>): SessionHistoryResponse {
  const nested = raw.data;
  if (
    nested &&
    typeof nested === 'object' &&
    !Array.isArray(nested) &&
    'sessionId' in nested &&
    typeof (nested as { sessionId?: unknown }).sessionId === 'string'
  ) {
    return nested as SessionHistoryResponse;
  }
  return raw as SessionHistoryResponse;
}

export async function fetchSessionChatHistory(sessionId: string): Promise<SessionHistoryResponse> {
  const res = await fetch(`${apiBase}/ai-rotational/session/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  const raw = (await res.json()) as Record<string, unknown>;
  const data = unwrapHistoryPayload(raw);
  if (!res.ok) {
    throw new Error(
      String(
        (raw as { message?: string }).message ??
          data.message ??
          `Failed to load chat history (HTTP ${res.status})`,
      ),
    );
  }
  return data;
}
