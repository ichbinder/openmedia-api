const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export type ChatMessage = { role: "system" | "user"; content: string };
export type ChatResult = { ok: true; json: unknown } | { ok: false; error: string };

type Attempt = { content: string } | { error: string };

const httpError = async (res: Response): Promise<string> => {
  if (res.status === 401) return "Key ungültig";
  if (res.status === 404) return "Modell unbekannt";
  if (res.status === 402) return "Guthaben bei OpenRouter aufgebraucht";
  if (res.status === 429) return "OpenRouter-Limit erreicht";
  if (res.status === 400 && /model/i.test(await res.text().catch(() => ""))) return "Modell unbekannt";
  return `OpenRouter-Fehler (HTTP ${res.status})`;
};

const attempt = async (key: string, model: string, messages: ChatMessage[], timeoutMs: number): Promise<Attempt> => {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, response_format: { type: "json_object" } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: await httpError(res) };
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    return { content: typeof content === "string" ? content : "" };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { error: name === "TimeoutError" || name === "AbortError" ? "Zeitüberschreitung" : "OpenRouter nicht erreichbar" };
  }
};

const parse = (content: string): { json: unknown } | null => {
  try {
    return { json: JSON.parse(content) };
  } catch {
    return null;
  }
};

export async function chatJson(
  key: string,
  model: string,
  messages: ChatMessage[],
  timeoutMs = 120_000,
): Promise<ChatResult> {
  for (let i = 0; i < 2; i++) {
    const result = await attempt(key, model, messages, timeoutMs);
    if ("error" in result) return { ok: false, error: result.error };
    const parsed = parse(result.content);
    if (parsed) return { ok: true, json: parsed.json };
  }
  return { ok: false, error: "Antwort der KI war kein gültiges JSON." };
}
