import prisma from "./prisma.js";
import { decrypt, encrypt } from "./crypto.js";

export async function getAiSettings(userId: string): Promise<{ model: string; hasKey: boolean } | null> {
  const row = await prisma.aiSettings.findUnique({ where: { userId } });
  return row ? { model: row.model, hasKey: row.keyCipher !== null } : null;
}

export async function saveAiSettings(userId: string, input: { model: string; apiKey?: string }): Promise<void> {
  let key: { keyCipher: string | null; keyIv: string | null; keyTag: string | null } | undefined;
  if (input.apiKey === "") {
    key = { keyCipher: null, keyIv: null, keyTag: null };
  } else if (input.apiKey !== undefined) {
    const { ciphertext, iv, tag } = encrypt(input.apiKey);
    key = { keyCipher: ciphertext, keyIv: iv, keyTag: tag };
  }
  await prisma.aiSettings.upsert({
    where: { userId },
    create: { userId, model: input.model, ...key },
    update: { model: input.model, ...key },
  });
}

export async function getAiKey(userId: string): Promise<string | null> {
  const row = await prisma.aiSettings.findUnique({ where: { userId } });
  if (!row?.keyCipher || !row.keyIv || !row.keyTag) return null;
  return decrypt(row.keyCipher, row.keyIv, row.keyTag);
}
