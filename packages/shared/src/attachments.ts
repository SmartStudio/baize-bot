import type { AttachmentMime } from "./domain.js";

export const imageMime = (bytes: Uint8Array): AttachmentMime | null => {
  const startsWith = (signature: readonly number[], offset = 0): boolean =>
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (startsWith([255, 216, 255])) return "image/jpeg";
  if (startsWith([82, 73, 70, 70]) && startsWith([87, 69, 66, 80], 8)) return "image/webp";
  if (startsWith([71, 73, 70, 56, 55, 97]) || startsWith([71, 73, 70, 56, 57, 97])) return "image/gif";
  return null;
};
