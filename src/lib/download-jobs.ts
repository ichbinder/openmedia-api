import type { DownloadJob, NzbFile, NzbMovie } from "../../generated/client/index.js";
import prisma from "./prisma.js";

// The pg driver adapter can surface a commit-time conflict as a raw
// DriverAdapterError without a Prisma code.
export function isSerializationFailure(err: any): boolean {
  return err?.code === "P2034" || err?.code === "40001" || err?.cause?.kind === "TransactionWriteConflict";
}

export async function startDownloadJob(
  nzbFileId: string,
  userId: string | null,
): Promise<
  | { kind: "created"; job: DownloadJob & { nzbFile: NzbFile & { movie: NzbMovie | null } } }
  | { kind: "conflict"; existingJob: DownloadJob }
> {
  // Serializable so two concurrent requests for the same file cannot both create a job.
  const result = await prisma.$transaction(async (tx) => {
    const existingJob = await tx.downloadJob.findFirst({
      where: {
        nzbFileId,
        status: { in: ["queued", "provisioning", "downloading", "uploading"] },
      },
    });
    if (existingJob) return { kind: "conflict" as const, existingJob };

    const job = await tx.downloadJob.create({
      data: { nzbFileId, userId },
      include: { nzbFile: { include: { movie: true } } },
    });
    return { kind: "created" as const, job };
  }, { isolationLevel: "Serializable" });

  if (result.kind === "created" && process.env.AUTO_PROVISION !== "false") {
    import("./provisioner.js").then(({ provisionDownload }) => {
      provisionDownload(result.job.id).catch((err) => {
        console.error("[download-job] Auto-provision failed:", err);
      });
    }).catch((err) => {
      console.error("[download-job] Failed to load provisioner module:", err);
    });
  }
  return result;
}
