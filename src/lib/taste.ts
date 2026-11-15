export type Verdict = "up" | "meh" | "down";

export const TAG_KEYS = [
  "spannend",
  "gut_erzaehlt",
  "witzig",
  "romantisch",
  "zu_brutal",
  "zu_viel_sex",
  "zaeh",
  "plump",
  "vorhersehbar",
] as const;
export const LIMIT_KEYS = ["gewalt_selbstzweck", "sex_hauptinhalt", "horror"] as const;
export const GENRE_KEYS = [
  "thriller",
  "mystery",
  "krimi",
  "drama",
  "romantik",
  "komoedie",
  "scifi",
  "fantasy",
  "action",
  "horror",
  "doku",
  "animation",
  "historie",
  "familie",
] as const;

export const TASTE_RULES = {
  MAX_PERSONS: 6,
  NAME_MAX: 40,
  LIKES_MAX: 2000,
  LIMITS_TEXT_MAX: 500,
} as const;

const VERDICTS: readonly string[] = ["up", "meh", "down"];
const SOURCES: readonly string[] = ["app", "quiz"];

export type RatingInput = {
  verdict: Verdict;
  tags: string[];
  forWhom: string | null;
  source: "app" | "quiz";
};
export type PersonInput = { id?: string; name: string; limits: string[]; limitsText: string };
export type TasteInput = { persons: PersonInput[]; genres: string[]; likesText: string };
type Failure = { error: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const keyList = (value: unknown, allowed: readonly string[]): string[] | null => {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === "string" && allowed.includes(v))) return null;
  return [...new Set(value as string[])];
};

export function traktVerdict(rating: number): Verdict | null {
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) return null;
  return rating >= 8 ? "up" : rating >= 5 ? "meh" : "down";
}

export function parseRatingInput(body: unknown, personIds: string[]): RatingInput | Failure {
  if (!isObj(body)) return { error: "Ungültige Anfrage" };
  const { verdict, tags = [], forWhom = null, source = "app" } = body;
  if (typeof verdict !== "string" || !VERDICTS.includes(verdict)) {
    return { error: "Ungültiges Urteil" };
  }
  const cleanTags = keyList(tags, TAG_KEYS);
  if (!cleanTags) return { error: "Ungültige Tags" };
  if (forWhom !== null && (typeof forWhom !== "string" || !personIds.includes(forWhom))) {
    return { error: "Unbekannte Person" };
  }
  if (typeof source !== "string" || !SOURCES.includes(source)) {
    return { error: "Ungültige Quelle" };
  }
  return {
    verdict: verdict as Verdict,
    tags: cleanTags,
    forWhom,
    source: source as RatingInput["source"],
  };
}

function parsePerson(raw: unknown, knownPersonIds: string[]): PersonInput | Failure {
  if (!isObj(raw)) return { error: "Ungültige Person" };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length < 1 || name.length > TASTE_RULES.NAME_MAX) {
    return { error: `Name muss 1 bis ${TASTE_RULES.NAME_MAX} Zeichen lang sein` };
  }
  const limits = keyList(raw.limits, LIMIT_KEYS);
  if (!limits) return { error: "Ungültige Grenzen" };
  const limitsText = raw.limitsText ?? "";
  if (typeof limitsText !== "string" || limitsText.length > TASTE_RULES.LIMITS_TEXT_MAX) {
    return { error: `Grenzen-Text darf höchstens ${TASTE_RULES.LIMITS_TEXT_MAX} Zeichen haben` };
  }
  if (raw.id === undefined) return { name, limits, limitsText };
  if (typeof raw.id !== "string" || !knownPersonIds.includes(raw.id)) {
    return { error: "Unbekannte Person" };
  }
  return { id: raw.id, name, limits, limitsText };
}

export function parseTasteInput(body: unknown, knownPersonIds: string[]): TasteInput | Failure {
  if (!isObj(body)) return { error: "Ungültige Anfrage" };
  const { persons: rawPersons, genres: rawGenres = [], likesText = "" } = body;
  if (
    !Array.isArray(rawPersons) ||
    rawPersons.length < 1 ||
    rawPersons.length > TASTE_RULES.MAX_PERSONS
  ) {
    return { error: `Es sind 1 bis ${TASTE_RULES.MAX_PERSONS} Personen erlaubt` };
  }
  const persons: PersonInput[] = [];
  for (const raw of rawPersons) {
    const person = parsePerson(raw, knownPersonIds);
    if ("error" in person) return person;
    persons.push(person);
  }
  const ids = persons.flatMap((p) => (p.id ? [p.id] : []));
  if (new Set(ids).size !== ids.length) return { error: "Person doppelt angegeben" };
  const genres = keyList(rawGenres, GENRE_KEYS);
  if (!genres) return { error: "Ungültige Genres" };
  if (typeof likesText !== "string" || likesText.length > TASTE_RULES.LIKES_MAX) {
    return { error: `Text darf höchstens ${TASTE_RULES.LIKES_MAX} Zeichen haben` };
  }
  return { persons, genres, likesText };
}
