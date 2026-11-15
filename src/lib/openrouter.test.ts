import { describe, it, expect, vi, afterEach } from "vitest";
import { chatJson } from "./openrouter.js";

const KEY = "sk-or-secret-key";
const messages = [{ role: "user" as const, content: "hi" }];
const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chatJson", () => {
  it("liefert gültiges JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply('{"a":1}'));
    vi.stubGlobal("fetch", fetchMock);
    expect(await chatJson(KEY, "m", messages)).toEqual({ ok: true, json: { a: 1 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body).response_format).toEqual({ type: "json_object" });
  });

  it("versucht es nach Müll genau einmal erneut", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply("Müll")).mockResolvedValueOnce(reply('{"b":2}'));
    vi.stubGlobal("fetch", fetchMock);
    expect(await chatJson(KEY, "m", messages)).toEqual({ ok: true, json: { b: 2 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("scheitert nach zweimal Müll", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => reply("Müll"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await chatJson(KEY, "m", messages)).toEqual({
      ok: false,
      error: "Antwort der KI war kein gültiges JSON.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "Key ungültig"],
    [404, "Modell unbekannt"],
    [402, "Guthaben bei OpenRouter aufgebraucht"],
    [429, "OpenRouter-Limit erreicht"],
    [500, "OpenRouter-Fehler (HTTP 500)"],
  ])("HTTP %i wird zu kurzem Text", async (status, error) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`{"error":"${KEY}"}`, { status })));
    expect(await chatJson(KEY, "m", messages)).toEqual({ ok: false, error });
  });

  it("400 mit Modellfehler heißt Modell unbekannt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"error":{"message":"x is not a valid model ID"}}', { status: 400 })),
    );
    expect(await chatJson(KEY, "m", messages)).toEqual({ ok: false, error: "Modell unbekannt" });
  });

  it("Zeitlimit wird gemeldet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal!.addEventListener("abort", () => rej(new DOMException("t", "TimeoutError")));
        }),
      ),
    );
    expect(await chatJson(KEY, "m", messages, 10)).toEqual({ ok: false, error: "Zeitüberschreitung" });
  });

  it("der Key steht in keiner Konsolenausgabe", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`boom ${KEY}`, { status: 401 })));
    await chatJson(KEY, "m", messages);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`net ${KEY}`)));
    await chatJson(KEY, "m", messages);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(KEY);
  });
});
