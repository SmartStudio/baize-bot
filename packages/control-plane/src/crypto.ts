import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = "v1:";

export class ToolCrypto {
  readonly #key: Buffer;

  constructor(keyHex: string) {
    if (!/^[\da-fA-F]{64}$/.test(keyHex)) throw new Error("TOOL_SECRET_KEY 必须是 64 位十六进制字符串");
    this.#key = Buffer.from(keyHex, "hex");
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
  }

  decrypt(ciphertext: string): string {
    if (!ciphertext.startsWith(PREFIX)) throw new Error("工具认证密文格式不对");
    const bytes = Buffer.from(ciphertext.slice(PREFIX.length), "base64");
    if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error("工具认证密文长度不对");
    const iv = bytes.subarray(0, IV_BYTES);
    const tag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const encrypted = bytes.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
}
