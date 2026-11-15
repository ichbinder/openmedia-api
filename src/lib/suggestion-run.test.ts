import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { chatJson } from "./openrouter.js";
import { collectCandidates } from "./candidates.js";
import { startSuggestionScheduler, stopSuggestionScheduler } from "./suggestion-run.js";
import prisma from "./prisma.js";

process.env.ENCRYPTION_MASTER_KEY ||= "a".repeat(64);

vi.mock("./openrouter.js", () => ({ chatJson: vi.fn() }));
vi.mock("./candidates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./candidates.js")>()),
  collectCandidates: vi.fn(),
}));


const app = createApp();

describe("startSuggestionScheduler", () => {
  let current: Date;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.mocked(chatJson).mockReset();
    vi.mocked(collectCandidates).mockReset();
    vi.mocked(collectCandidates).mockResolvedValue([]);
    vi.mocked(chatJson).mockResolvedValue({ ok: false, error: "Key ungültig" });
    const res = await request(app).post("/auth/register").send({ email: "sch@test.de", password: "test123", name: "T" });
    await request(app).put("/ai-settings").set({ Authorization: `Bearer ${res.body.token}` }).send({ model: "m", apiKey: "sk-1" });
    await prisma.suggestionRun.deleteMany();
    current = new Date("2026-01-15T01:00:00Z");
    startSuggestionScheduler(() => current);
  });

  afterEach(() => {
    stopSuggestionScheduler();
    vi.useRealTimers();
  });

  const tick = () => vi.advanceTimersByTimeAsync(60_000);

  it("03:00 Berlin startet genau einen Durchgang, 03:01 keinen weiteren", async () => {
    await tick();
    expect(chatJson).not.toHaveBeenCalled();

    current = new Date("2026-01-15T02:00:00Z");
    await tick();
    await vi.waitFor(() => expect(chatJson).toHaveBeenCalledTimes(1));

    current = new Date("2026-01-15T02:01:00Z");
    await tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(chatJson).toHaveBeenCalledTimes(1);
  });

  it("beachtet die Sommerzeit", async () => {
    current = new Date("2026-07-15T01:00:00Z");
    await tick();
    await vi.waitFor(() => expect(chatJson).toHaveBeenCalledTimes(1));
  });
});
