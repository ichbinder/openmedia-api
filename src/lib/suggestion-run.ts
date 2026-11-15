import prisma from "./prisma.js";
import { getAiKey, getAiSettings } from "./ai-settings-service.js";
import { chatJson } from "./openrouter.js";
import { collectCandidates, pickBecauseTitle } from "./candidates.js";
import { buildMessages, parseSuggestions } from "./suggestion-ai.js";
import { getTaste } from "./taste-service.js";
import { getTitleInfos, titleKey } from "./title-info.js";
import type { Verdict } from "./taste.js";
import type { Kind } from "./title-meta.js";

const MIN_INTERVAL_MS = 10 * 60_000;
const STALE_RUNNING_MS = 15 * 60_000;
const KEPT_RUNS = 7;
const RECENT_PASS_MS = 20 * 60 * 60_000;
const MAX_RATED = 150;
const MAX_SEEN = 100;
const SCHEDULE_HOUR = 3;
const SCHEDULE_ZONE = "Europe/Berlin";
const NO_RESULT_ERROR = "Die KI hat keine passenden Vorschläge geliefert.";
const GENERIC_ERROR = "Beim Erstellen der Vorschläge ist ein Fehler aufgetreten.";

const activeUsers = new Set<string>();

export async function isRunning(userId: string): Promise<boolean> {
  if (activeUsers.has(userId)) return true;
  const stale = new Date(Date.now() - STALE_RUNNING_MS);
  return (await prisma.suggestionRun.count({ where: { userId, status: "running", startedAt: { gt: stale } } })) > 0;
}

async function loadTasteInput(userId: string) {
  const [taste, ratings, dismissals] = await Promise.all([
    getTaste(userId),
    prisma.titleRating.findMany({ where: { userId }, orderBy: { ratedAt: "desc" } }),
    prisma.titleDismissal.findMany({ where: { userId } }),
  ]);
  const rated = ratings.filter((r) => r.verdict !== null).slice(0, MAX_RATED);
  const seen = ratings.filter((r) => r.verdict === null).slice(0, MAX_SEEN);
  const infos = await getTitleInfos(
    [...rated, ...seen, ...dismissals].map((t) => ({ kind: t.kind as Kind, tmdbId: t.tmdbId })),
  );
  const named = <T extends { kind: string; tmdbId: number }>(rows: T[]) =>
    rows.flatMap((row) => {
      const info = infos.get(titleKey({ kind: row.kind as Kind, tmdbId: row.tmdbId }));
      return info ? [{ row, name: info.name, year: info.year }] : [];
    });
  return {
    taste,
    rated: named(rated).map(({ row, name, year }) => ({ name, year, verdict: row.verdict as Verdict, tags: row.tags })),
    seen: named(seen).map(({ name, year }) => ({ name, year })),
    dismissed: named(dismissals).map(({ name, year }) => ({ name, year })),
  };
}

async function markFailed(runId: string, userId: string, error: string): Promise<void> {
  await prisma.$transaction([
    prisma.suggestionRun.update({ where: { id: runId }, data: { status: "failed", error, finishedAt: new Date() } }),
    prisma.suggestionRun.deleteMany({ where: { userId, status: "failed", id: { not: runId } } }),
  ]);
}

async function markDone(runId: string, userId: string, rows: ReturnType<typeof parseSuggestions>): Promise<void> {
  const data = rows.flatMap(({ row, items }) =>
    items.map((item, position) => ({ runId, row, position, kind: item.kind, tmdbId: item.tmdbId, reason: item.reason })),
  );
  await prisma.$transaction(async (tx) => {
    await tx.suggestion.createMany({ data });
    await tx.suggestionRun.update({ where: { id: runId }, data: { status: "done", error: null, finishedAt: new Date() } });
    await tx.suggestion.deleteMany({ where: { run: { userId }, runId: { not: runId } } });
    const excess = await tx.suggestionRun.findMany({
      where: { userId },
      orderBy: { startedAt: "desc" },
      skip: KEPT_RUNS,
      select: { id: true },
    });
    await tx.suggestionRun.deleteMany({ where: { id: { in: excess.map((r) => r.id) } } });
  });
}

export async function runSuggestions(userId: string): Promise<"done" | "failed" | "skipped"> {
  if (activeUsers.has(userId)) return "skipped";
  activeUsers.add(userId);
  let runId: string | null = null;
  try {
    const [key, settings] = await Promise.all([getAiKey(userId), getAiSettings(userId)]);
    if (!key || !settings) return "skipped";

    const because = await pickBecauseTitle(userId);
    const run = await prisma.suggestionRun.create({
      data: {
        userId,
        status: "running",
        model: settings.model,
        becauseKind: because?.kind,
        becauseTmdbId: because?.tmdbId,
        becauseName: because?.name,
      },
    });
    runId = run.id;
    const now = new Date();
    const candidates = await collectCandidates(userId, because, now);
    const input = await loadTasteInput(userId);
    const result = await chatJson(key, settings.model, buildMessages({ ...input, candidates, because, now }));
    if (!result.ok) {
      await markFailed(runId, userId, result.error);
      return "failed";
    }
    const rows = parseSuggestions(result.json, candidates, now);
    if (!rows.length) {
      await markFailed(runId, userId, NO_RESULT_ERROR);
      return "failed";
    }
    await markDone(runId, userId, rows);
    return "done";
  } catch (err) {
    console.error("[suggestions] Lauf fehlgeschlagen:", err instanceof Error ? err.name : "unbekannt");
    if (runId) await markFailed(runId, userId, GENERIC_ERROR).catch(() => undefined);
    return "failed";
  } finally {
    activeUsers.delete(userId);
  }
}

export async function requestRefresh(userId: string): Promise<"started" | "too_soon" | "running" | "no_key"> {
  if (!(await getAiSettings(userId))?.hasKey) return "no_key";
  if (await isRunning(userId)) return "running";
  const last = await prisma.suggestionRun.findFirst({ where: { userId }, orderBy: { startedAt: "desc" } });
  if (last && Date.now() - last.startedAt.getTime() < MIN_INTERVAL_MS) return "too_soon";
  if (activeUsers.has(userId)) return "running";
  void runSuggestions(userId);
  return "started";
}

const berlinParts = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULE_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")), minute: Number(get("minute")) };
};

async function runForAllAccounts(now: Date): Promise<void> {
  const accounts = await prisma.aiSettings.findMany({ where: { keyCipher: { not: null } }, select: { userId: true } });
  const since = new Date(now.getTime() - RECENT_PASS_MS);
  for (const { userId } of accounts) {
    if (await prisma.suggestionRun.count({ where: { userId, startedAt: { gt: since } } })) continue;
    await runSuggestions(userId);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastPassDay: string | null = null;

export function startSuggestionScheduler(now: () => Date = () => new Date()): void {
  stopSuggestionScheduler();
  timer = setInterval(() => {
    const current = now();
    const { day, hour } = berlinParts(current);
    if (hour !== SCHEDULE_HOUR || lastPassDay === day) return;
    lastPassDay = day;
    runForAllAccounts(current).catch((err) => console.error("[suggestions] Durchgang fehlgeschlagen:", err instanceof Error ? err.name : "unbekannt"));
  }, 60_000);
  timer.unref();
}

export function stopSuggestionScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  lastPassDay = null;
}
