/**
 * ZIP-Repackaging mit bootstrap.json + MD5
 *
 * Nimmt ein Source-ZIP-Buffer + {apiUrl, apiToken}, entpackt im Speicher,
 * fuegt `bootstrap.json` neben den DLLs hinzu, packt neu und berechnet MD5.
 *
 * Deterministisch: gleiche (sourceZip, apiUrl, apiToken) → gleiche Bytes.
 * Damit stimmt der im Manifest deklarierte MD5 mit dem Download ueberein.
 *
 * Performance-Ziel: <500ms fuer typisches Plugin-ZIP (~1-5 MB).
 */

import { createHash } from "node:crypto";
import JSZip from "jszip";

/** Festes Datum fuer bootstrap.json-Eintrag — sorgt fuer deterministische ZIP-Bytes. */
const BOOTSTRAP_FIXED_DATE = new Date("2020-01-01T00:00:00Z");

export interface RepackOptions {
  apiUrl: string;
  apiToken: string;
}

export interface RepackResult {
  buffer: Buffer;
  md5: string;
  size: number;
}

/**
 * Repackt das Source-ZIP mit eingebetteter bootstrap.json.
 *
 * @param sourceZipBuffer  Der Original-ZIP-Puffer (von GitHub Release).
 * @param opts             {apiUrl, apiToken} — Werte fuer bootstrap.json.
 * @returns                {buffer, md5, size} — repacktes ZIP + MD5 + Groesse.
 */
export async function repackPluginWithBootstrap(
  sourceZipBuffer: Buffer,
  opts: RepackOptions,
): Promise<RepackResult> {
  const zip = await JSZip.loadAsync(sourceZipBuffer);

  // bootstrap.json neben den DLLs (Root des ZIP)
  const bootstrap = JSON.stringify(
    { apiUrl: opts.apiUrl, apiToken: opts.apiToken },
    null,
    2,
  );
  zip.file("bootstrap.json", bootstrap, { date: BOOTSTRAP_FIXED_DATE });

  const startMs = Date.now();

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const durationMs = Date.now() - startMs;
  console.log(
    `[plugin-repack] repack complete: size=${buffer.length} duration=${durationMs}ms`,
  );

  const md5 = createHash("md5").update(buffer).digest("hex");

  return { buffer, md5, size: buffer.length };
}
