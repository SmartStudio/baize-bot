import type { Preference, UserId } from "@baize/shared";
import type { Db } from "../db/client.js";

/**
 * 第 2 期形状占位：随 config 下发的偏好（不含 private 的）。U-偏好 接上 bot_preferences 表之前恒为空数组，
 * 数组本身恒带，运行器靠它整份对账。
 */
export async function listPreferencesForConfig(_db: Db, _ownerId: UserId): Promise<Preference[]> {
  return [];
}
