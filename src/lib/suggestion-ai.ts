import type { Candidate, Hint } from "./candidates.js";
import type { TasteView } from "./taste-service.js";
import type { Verdict } from "./taste.js";
import { titleKey } from "./title-info.js";
import type { Kind } from "./title-meta.js";

type Message = { role: "system" | "user"; content: string };
type Named = { name: string; year: number | null };
type Rated = Named & { verdict: Verdict; tags: string[] };

export type SuggestionRow = { row: Hint; items: { kind: Kind; tmdbId: number; reason: string }[] };

export const HARD_EXCLUSION_RULE =
  "Ein Titel, der gegen die Grenze irgendeiner Person verstößt, darf in keine Reihe. " +
  "Prüfe jeden Kandidaten gegen die Grenzen ALLER Personen; eine Grenze gilt auch dann, wenn eine andere Person den Titel mögen würde. " +
  "Im Zweifel lass den Titel weg.";

const LIMIT_LABELS: Record<string, string> = {
  gewalt_selbstzweck: "Gewalt als Selbstzweck",
  sex_hauptinhalt: "Sex als Hauptinhalt",
  horror: "Horror",
};
const limitLabel = (key: string) => LIMIT_LABELS[key] ?? key;

const ROWS: Hint[] = ["neu", "aehnlich", "serien", "perlen"];
const MAX_RATED = 150;
const MAX_SEEN = 100;
const MAX_PER_ROW = 50;
const MAX_REASON = 90;
const PERLEN_MIN_AGE = 3;
const VERDICT_EMOJI: Record<Verdict, string> = { up: "👍", meh: "😐", down: "👎" };

const label = ({ name, year }: Named) => (year ? `${name} (${year})` : name);

function systemPrompt(because: string | null): string {
  return [
    "Du bist ein Film- und Serienberater für einen Haushalt. Wähle ausschließlich aus der Kandidatenliste und antworte nur mit JSON.",
    `Format: {"rows":{"neu":[],"aehnlich":[],"serien":[],"perlen":[]}} mit Einträgen {"id":"movie-123","reason":"…"}.`,
    "Fülle jede Reihe möglichst mit 20 bis 50 Titeln, die beste Wahl zuerst. Der Grund ist ein kurzer deutscher Satz mit höchstens 90 Zeichen.",
    "Regeln für die Reihen:",
    "- neu: nur Kandidaten mit Hinweis neu.",
    "- aehnlich: nur Kandidaten mit Hinweis aehnlich" + (because ? ` (Titel, die zu „${because}“ passen).` : "."),
    "- serien: nur Serien.",
    "- perlen: nur Titel, die älter als 3 Jahre sind.",
    "Jeder Titel darf nur in einer Reihe vorkommen. Schlage nie bereits bewertete, gesehene oder abgelehnte Titel vor.",
    HARD_EXCLUSION_RULE,
  ].join("\n");
}

function userPrompt(i: Parameters<typeof buildMessages>[0]): string {
  const persons = i.taste.persons.map(
    (p) => `- ${p.name}: harte Grenzen: ${p.limits.map(limitLabel).join(", ") || "keine"}; ${p.limitsText || "kein weiterer Text"}`,
  );
  const rated = i.rated.slice(0, MAX_RATED).map((r) => {
    const tags = r.tags.length ? ` [${r.tags.join(", ")}]` : "";
    return `${label(r)} — ${VERDICT_EMOJI[r.verdict]}${tags}`;
  });
  const candidates = i.candidates.map((c) => {
    const scores = [c.critics != null && `🍅${c.critics}`, c.audience != null && `🍿${c.audience}`].filter(Boolean).join(" ");
    return [
      titleKey(c), label(c), c.genres.join("/"), c.overview.slice(0, 200), c.label ?? "", scores, `Hinweis: ${c.hints.join(",")}`,
    ].join(" | ");
  });
  return [
    `Genres des Haushalts: ${i.taste.genres.join(", ") || "keine Angabe"}`,
    `Was schaut ihr gern?: ${i.taste.likesText || "keine Angabe"}`,
    `Personen (harter Ausschluss): ${HARD_EXCLUSION_RULE}`,
    ...persons,
    "Bewertungen (neueste zuerst):",
    ...rated,
    "Nur gesehen:",
    ...i.seen.slice(0, MAX_SEEN).map(label),
    "Kein Interesse:",
    ...i.dismissed.map(label),
    "Kandidaten (id | Name | Genres | Beschreibung | Herkunft | Wertung | Hinweis):",
    ...candidates,
  ].join("\n");
}

export function buildMessages(input: {
  taste: TasteView;
  rated: Rated[];
  seen: Named[];
  dismissed: Named[];
  candidates: Candidate[];
  because: { name: string } | null;
  now: Date;
}): Message[] {
  return [
    { role: "system", content: systemPrompt(input.because?.name ?? null) },
    { role: "user", content: userPrompt(input) },
  ];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function cleanReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const reason = raw.trim();
  if (!reason) return null;
  return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1)}…` : reason;
}

function allowed(row: Hint, c: Candidate, maxYear: number): boolean {
  if (row === "serien") return c.kind === "show";
  if (row === "perlen") return c.year != null && c.year <= maxYear;
  return c.hints.includes(row);
}

export function parseSuggestions(json: unknown, candidates: Candidate[], now: Date): SuggestionRow[] {
  if (!isRecord(json) || !isRecord(json.rows)) return [];
  const byKey = new Map(candidates.map((c) => [titleKey(c), c]));
  const maxYear = now.getUTCFullYear() - PERLEN_MIN_AGE;
  const used = new Set<string>();
  const result: SuggestionRow[] = [];

  for (const row of ROWS) {
    const entries = json.rows[row];
    if (!Array.isArray(entries)) continue;
    const items: SuggestionRow["items"] = [];
    for (const entry of entries) {
      if (items.length >= MAX_PER_ROW) break;
      if (!isRecord(entry) || typeof entry.id !== "string") continue;
      const c = byKey.get(entry.id);
      const reason = cleanReason(entry.reason);
      if (!c || !reason || used.has(entry.id) || !allowed(row, c, maxYear)) continue;
      used.add(entry.id);
      items.push({ kind: c.kind, tmdbId: c.tmdbId, reason });
    }
    if (items.length) result.push({ row, items });
  }
  return result;
}
