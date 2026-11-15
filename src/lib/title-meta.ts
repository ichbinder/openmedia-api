export type Kind = "movie" | "show";
export type Brand =
  | "netflix"
  | "prime"
  | "disney"
  | "apple"
  | "hbo"
  | "paramount"
  | "sky"
  | "cinema"
  | "other";
export type Ratings = {
  critics?: number;
  audience?: number;
  imdb?: number;
  metacritic?: number;
  letterboxd?: number;
  trakt?: number;
  tmdb?: number;
};
export type StoredRatings = Record<string, { value: number; votes: number | null }>;

export const META_RULES = {
  STALE_DAYS: 7,
  FRESH_TITLE_STALE_DAYS: 1,
  NOT_FOUND_STALE_DAYS: 1,
  MAX_ITEMS: 60,
  CONCURRENCY: 6,
  TIMEOUT_MS: 8000,
} as const;

type Origin = { label: string; brand: Brand };

const CINEMA: Origin = { label: "KINO", brand: "cinema" };

const KNOWN: Record<string, Origin> = {
  netflix: { label: "NETFLIX", brand: "netflix" },
  amazon: { label: "PRIME VIDEO", brand: "prime" },
  amazonprime: { label: "PRIME VIDEO", brand: "prime" },
  amazonprimevideo: { label: "PRIME VIDEO", brand: "prime" },
  primevideo: { label: "PRIME VIDEO", brand: "prime" },
  disney: { label: "DISNEY+", brand: "disney" },
  "disney+": { label: "DISNEY+", brand: "disney" },
  disneyplus: { label: "DISNEY+", brand: "disney" },
  appletv: { label: "APPLE TV+", brand: "apple" },
  "appletv+": { label: "APPLE TV+", brand: "apple" },
  appletvplus: { label: "APPLE TV+", brand: "apple" },
  hbo: { label: "HBO", brand: "hbo" },
  hbomax: { label: "HBO", brand: "hbo" },
  max: { label: "HBO", brand: "hbo" },
  paramount: { label: "PARAMOUNT+", brand: "paramount" },
  "paramount+": { label: "PARAMOUNT+", brand: "paramount" },
  paramountplus: { label: "PARAMOUNT+", brand: "paramount" },
  sky: { label: "SKY", brand: "sky" },
  skyatlantic: { label: "SKY", brand: "sky" },
  skyone: { label: "SKY", brand: "sky" },
  skydeutschland: { label: "SKY", brand: "sky" },
};

function resolve(raw: string): Origin {
  const name = raw.split(",")[0].trim();
  const key = name.toLowerCase().replace(/\s+/g, "");
  return KNOWN[key] ?? { label: name.toLocaleUpperCase("de-DE"), brand: "other" };
}

export function originLabel(
  kind: Kind,
  raw: { network?: string | null; digitalDetail?: string | null },
): Origin | null {
  if (kind === "show") {
    return raw.network?.trim() ? resolve(raw.network) : null;
  }
  const detail = raw.digitalDetail?.trim();
  if (!detail || detail.toLowerCase() === "tvod") return CINEMA;
  return resolve(detail);
}

export function storedRatings(
  raw: { source: string; value: number | null; votes?: number | null }[],
): StoredRatings {
  const out: StoredRatings = {};
  for (const r of raw) {
    if (r.value !== null) out[r.source] = { value: r.value, votes: r.votes ?? null };
  }
  return out;
}

const RATING_SOURCES = {
  critics: "tomatoes",
  audience: "popcorn",
  imdb: "imdb",
  metacritic: "metacritic",
  letterboxd: "letterboxd",
  trakt: "trakt",
  tmdb: "tmdb",
} as const;

export function toRatings(stored: StoredRatings): Ratings {
  const out: Ratings = {};
  for (const [field, source] of Object.entries(RATING_SOURCES) as [keyof Ratings, string][]) {
    if (stored[source]) out[field] = stored[source].value;
  }
  return out;
}

export function isStale(
  row: { status: string; year: number | null; fetchedAt: Date },
  now: Date,
): boolean {
  const fresh =
    row.status === "not_found" ||
    (row.year !== null && row.year >= now.getUTCFullYear() - 1);
  const days = fresh ? META_RULES.FRESH_TITLE_STALE_DAYS : META_RULES.STALE_DAYS;
  return now.getTime() - row.fetchedAt.getTime() > days * 86_400_000;
}
