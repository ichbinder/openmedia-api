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
  | { status: "error"; reason: string };

/**
 * Search for a movie on TMDB and return the best match.
 * Returns structured result distinguishing "not found" from "error".
 */
export async function searchTmdbMovie(
  title: string,
  year?: number | null
): Promise<TmdbLookupResult> {
  if (!TMDB_API_KEY) {
    if (process.env.NODE_ENV === "test" || process.env.ALLOW_TMDB_FALLBACK === "true") {
      console.log("[tmdb] No TMDB_API_KEY set — falling back to not_found (test/dev mode)");
      return { status: "not_found" };
    }
    return { status: "error", reason: "TMDB_API_KEY is not configured" };
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
    const tmdbId = match.id;

    // Fetch full details with German + English
    const detailRes = await fetch(
      `${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=de-DE`
    );
    const detailDe = detailRes.ok ? (await detailRes.json()) as Record<string, any> : null;

    const detailEnRes = await fetch(
      `${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`
    );
    const detailEn = detailEnRes.ok ? (await detailEnRes.json()) as Record<string, any> : null;

    const releaseDate = detailDe?.release_date || detailEn?.release_date || "";
    const releaseYear = releaseDate ? Number(releaseDate.slice(0, 4)) : null;

    const movie: TmdbMovieResult = {
      tmdbId,
      imdbId: detailDe?.imdb_id || detailEn?.imdb_id || null,
      titleDe: detailDe?.title || match.title || title,
      titleEn: detailEn?.title || match.original_title || title,
      description: detailDe?.overview || detailEn?.overview || "",
      year: releaseYear,
      posterPath: match.poster_path || null,
    };

    console.log(`[tmdb] Matched: "${title}" → ${movie.titleEn} (${movie.tmdbId})`);
    return { status: "found", movie };
  } catch (err) {
    console.error("[tmdb] Lookup error:", err);
    return { status: "error", reason: "Network or unexpected error" };
  }
}
