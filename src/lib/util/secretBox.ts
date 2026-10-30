import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * DB 에 두는 외부 토큰(카카오 액세스·리프레시 토큰)을 서버 .env 의 TOKEN_ENCRYPTION_KEY(32바이트, base64)로 암호화한다.
 * AES-256-GCM, 형식 "v1:<iv>:<tag>:<암호문>"(base64). 키가 바뀌면 복호화할 수 없으므로 다시 연결해야 한다.
 */
function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY || "";
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY 가 없거나 32바이트(base64)가 아닙니다.");
  return k;
}

export function tokenEncryptionConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function open(sealed: string): string {
  const [v, iv, tag, enc] = sealed.split(":");
  if (v !== "v1" || !iv || !tag || !enc) throw new Error("암호문 형식 오류");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
}
