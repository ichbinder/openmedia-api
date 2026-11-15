import prisma from "./prisma.js";
import { PROGRESS, isFinishedPosition, resumePosition, titleState } from "./watch-progress.js";

export type Resume = { positionSec: number; durationSec: number; finished: boolean };

export type RecordResult =
  | { status: "ok"; progress: Resume }
  | { status: "invalid" }
  | { status: "not_found" };

export async function recordProgress(
  userId: string,
  nzbFileId: string,
  positionSec: number,
  durationSec: number,
): Promise<RecordResult> {
  if (
    !Number.isFinite(positionSec) ||
    !Number.isFinite(durationSec) ||
    positionSec < 0 ||
    durationSec <= 0 ||
    positionSec > durationSec * (1 + PROGRESS.LENGTH_TOLERANCE) + 5
  ) {
    return { status: "invalid" };
  }

  const file = await prisma.nzbFile.findUnique({
    where: { id: nzbFileId },
    select: { movieId: true, episodeId: true },
  });
  if (!file || (!file.movieId && !file.episodeId)) return { status: "not_found" };

  const position = Math.round(positionSec);
  const duration = Math.round(durationSec);
  const now = new Date();
  const finishedNow = isFinishedPosition(position, duration);

  const where = file.movieId
    ? { userId_movieId: { userId, movieId: file.movieId } }
    : { userId_episodeId: { userId, episodeId: file.episodeId! } };

  const row = await prisma.watchProgress.upsert({
    where,
    create: {
      userId,
      movieId: file.movieId,
      episodeId: file.episodeId,
      nzbFileId,
      positionSec: position,
      durationSec: duration,
      finishedAt: finishedNow ? now : null,
    },
    update: {
      nzbFileId,
      positionSec: position,
      durationSec: duration,
      hiddenAt: null,
      ...(finishedNow ? { finishedAt: now } : {}),
    },
  });

  return {
    status: "ok",
    progress: { positionSec: row.positionSec, durationSec: row.durationSec, finished: row.finishedAt !== null },
  };
}

export async function getResume(
  userId: string,
  file: { movieId: string | null; episodeId: string | null; duration: number | null },
): Promise<Resume | null> {
  if (!file.movieId && !file.episodeId) return null;
  const row = await prisma.watchProgress.findFirst({
    where: file.movieId ? { userId, movieId: file.movieId } : { userId, episodeId: file.episodeId },
  });
  if (!row || titleState(row) !== "started") return null;
  return {
    positionSec: resumePosition(row, file.duration),
    durationSec: row.durationSec,
    finished: false,
  };
}
