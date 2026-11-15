export const PROGRESS = {
  REPORT_INTERVAL_SEC: 30,
  FINISHED_RATIO: 0.9,
  RESUME_MIN_SEC: 60,
  NEXT_BUTTON_SEC: 60,
  COUNTDOWN_SEC: 10,
  LENGTH_TOLERANCE: 0.02,
  RESUME_REWIND_SEC: 5,
  CONTINUE_LIMIT: 20,
} as const;

export type TitleState = "new" | "started" | "finished";

const STREAM_QUALITY_ORDER = ["2160p", "1080p", "720p", "480p"];

function streamQualityRank(tier: string | null): number {
  const index = STREAM_QUALITY_ORDER.indexOf(tier ?? "");
  return index === -1 ? STREAM_QUALITY_ORDER.length : index;
}

export function isFinishedPosition(positionSec: number, durationSec: number): boolean {
  return positionSec >= durationSec * PROGRESS.FINISHED_RATIO;
}

export function titleState(p: { positionSec: number; durationSec: number; finishedAt: Date | null }): TitleState {
  if (p.positionSec > PROGRESS.RESUME_MIN_SEC && !isFinishedPosition(p.positionSec, p.durationSec)) return "started";
  return p.finishedAt ? "finished" : "new";
}

export function resumePosition(saved: { positionSec: number; durationSec: number }, fileDurationSec: number | null): number {
  const sameLength =
    fileDurationSec === null ||
    Math.abs(fileDurationSec - saved.durationSec) / saved.durationSec <= PROGRESS.LENGTH_TOLERANCE;
  const position = sameLength ? saved.positionSec : (saved.positionSec / saved.durationSec) * fileDurationSec;
  return Math.max(0, Math.round(position - PROGRESS.RESUME_REWIND_SEC));
}

export function pickStreamableFile<
  T extends { s3StreamKey: string | null; status: string; qualityTier: string | null; resolution: string | null; fileSize: bigint | null },
>(files: T[]): T | undefined {
  return files
    .filter((f) => f.s3StreamKey && f.status !== "broken")
    .sort((a, b) => {
      const byQuality = streamQualityRank(a.qualityTier ?? a.resolution) - streamQualityRank(b.qualityTier ?? b.resolution);
      if (byQuality !== 0) return byQuality;
      return Number((b.fileSize ?? 0n) - (a.fileSize ?? 0n));
    })[0];
}
