import type { Response } from "express";
import { TmdbUnavailableError } from "../lib/episode-requests.js";
import { IndexerError } from "../lib/treasure-maps.js";

export function handleIndexerError(err: unknown, res: Response, context: string, fallbackMessage: string): void {
  if (err instanceof IndexerError) {
    if (err.reason === "not_configured") {
      res.status(503).json({ error: "Indexer ist nicht eingerichtet.", reason: "indexer_not_configured" });
    } else {
      res.status(502).json({ error: "Indexer gerade nicht erreichbar.", reason: "indexer_error" });
    }
    return;
  }
  if (err instanceof TmdbUnavailableError) {
    if (err.status === "disabled") {
      res.status(503).json({
        error: "TMDB-Matching ist nicht verfügbar — Server-Konfiguration fehlt.",
        reason: "tmdb_disabled",
      });
    } else {
      res.status(502).json({ error: "TMDB gerade nicht erreichbar.", reason: "tmdb_error" });
    }
    return;
  }
  console.error(`[${context}] error:`, err);
  res.status(500).json({ error: fallbackMessage });
}
