const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const TMDB_BASE = "https://api.themoviedb.org/3";

export interface TmdbMovieResult {
  tmdbId: number;
  imdbId: string | null;
  titleDe: string;
  titleEn: string;
  description: string;
  year: number | null;
  posterPath: string | null;
}

export type TmdbLookupResult =
  | { status: "found"; movie: TmdbMovieResult }
  | { status: "not_found" }
  | { status: "error"; reason: string }
  // TMDB is not configured at all — no API key present. Distinct from error
  // so callers can treat this as a server misconfiguration (503) rather than
  // confusing it with a transient failure or a real no-match.
  | { status: "disabled"; reason: string };

/**
 * Fetch full movie details for a known TMDB ID in both German and English.
 * Shared helper used by searchTmdbMovie (after a search match) and
 * searchTmdbMovieById (direct lookup for the manual assignment flow).
 *
 * Returns a fully populated TmdbMovieResult or null if the movie could not be
 * loaded (e.g. 404 on both language endpoints).
 */
async function fetchTmdbMovieDetails(
  tmdbId: number,
  fallbackTitle?: string,
  fallbackOriginalTitle?: string,
  fallbackPosterPath?: string | null,
): Promise<TmdbMovieResult | null> {
  const detailRes = await fetch(
    `${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=de-DE`
  );
  const detailDe = detailRes.ok ? (await detailRes.json()) as Record<string, any> : null;

  const detailEnRes = await fetch(
    `${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`
  );
  const detailEn = detailEnRes.ok ? (await detailEnRes.json()) as Record<string, any> : null;

  // If neither endpoint succeeded, the ID is invalid.
  if (!detailDe && !detailEn) return null;

  const releaseDate = detailDe?.release_date || detailEn?.release_date || "";
  const releaseYear = releaseDate ? Number(releaseDate.slice(0, 4)) : null;

  return {
    tmdbId,
    imdbId: detailDe?.imdb_id || detailEn?.imdb_id || null,
    titleDe: detailDe?.title || fallbackTitle || String(tmdbId),
    titleEn: detailEn?.title || fallbackOriginalTitle || detailDe?.original_title || fallbackTitle || String(tmdbId),
    description: detailDe?.overview || detailEn?.overview || "",
    year: releaseYear,
    posterPath: detailDe?.poster_path || detailEn?.poster_path || fallbackPosterPath || null,
  };
}

/**
 * Search for a movie on TMDB and return the best match.
 * Returns a structured result distinguishing four cases:
 * - found: a matching movie, with metadata.
 * - not_found: TMDB returned zero matches for the title — definitive.
 * - error: transient failure (rate limit, 5xx, network) — caller may retry.
 * - disabled: TMDB_API_KEY is not configured — server misconfiguration.
 */
export async function searchTmdbMovie(
  title: string,
  year?: number | null
): Promise<TmdbLookupResult> {
  if (!TMDB_API_KEY) {
    console.warn("[tmdb] TMDB_API_KEY is not set — returning 'disabled' status");
    return { status: "disabled", reason: "TMDB_API_KEY is not configured" };
  }

  try {
    // Search in German first
    const searchParams = new URLSearchParams({
      api_key: TMDB_API_KEY,
      query: title,
      language: "de-DE",
      ...(year ? { year: String(year) } : {}),
    });

    const searchRes = await fetch(`${TMDB_BASE}/search/movie?${searchParams}`);

    if (searchRes.status === 429) {
      return { status: "error", reason: "TMDB rate limit exceeded" };
    }
    if (!searchRes.ok) {
      return { status: "error", reason: `TMDB search failed: ${searchRes.status}` };
    }

    const searchData = (await searchRes.json()) as { results?: Array<{ id: number; title: string; original_title: string; poster_path: string | null }> };
    if (!searchData.results?.length) {
      return { status: "not_found" };
    }

    const match = searchData.results[0];
    const movie = await fetchTmdbMovieDetails(
      match.id,
      match.title,
      match.original_title,
      match.poster_path,
    );

    if (!movie) {
      // Search matched but details endpoint 404'd — treat as not_found
      return { status: "not_found" };
    }

    console.log(`[tmdb] Matched: "${title}" → ${movie.titleEn} (${movie.tmdbId})`);
    return { status: "found", movie };
  } catch (err) {
    console.error("[tmdb] Lookup error:", err);
    return { status: "error", reason: "Network or unexpected error" };
  }
}

/**
 * Look up a movie by its known TMDB ID. Used by the manual assign-movie flow
 * where the user has already picked the movie from a TMDB search UI and the
 * client sends the tmdbId directly.
 *
 * Same result shape as searchTmdbMovie — found / not_found / error / disabled.
 * A 404 from TMDB translates to not_found (the ID was invalid or the movie
 * was removed).
 */
export async function searchTmdbMovieById(tmdbId: number): Promise<TmdbLookupResult> {
  if (!TMDB_API_KEY) {
    console.warn("[tmdb] TMDB_API_KEY is not set — returning 'disabled' status");
    return { status: "disabled", reason: "TMDB_API_KEY is not configured" };
  }

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return { status: "error", reason: `Invalid tmdbId: ${tmdbId}` };
  }

  try {
    const movie = await fetchTmdbMovieDetails(tmdbId);

    if (!movie) {
      console.log(`[tmdb] By-id lookup: ${tmdbId} not found`);
      return { status: "not_found" };
    }

    console.log(`[tmdb] By-id lookup: ${tmdbId} → ${movie.titleEn}`);
    return { status: "found", movie };
  } catch (err) {
    console.error(`[tmdb] By-id lookup error for ${tmdbId}:`, err);
    return { status: "error", reason: "Network or unexpected error" };
  }
}
