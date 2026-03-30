import { type Request, type Response, type NextFunction } from "express";

/**
 * Global error handler — catches unhandled errors in routes.
 * Logs the error and returns a clean JSON response.
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error(`[error] ${err.message}`, err.stack ? `\n${err.stack}` : "");

  res.status(500).json({
    error: "Interner Serverfehler.",
    ...(process.env.NODE_ENV === "development" && { detail: err.message }),
  });
}
