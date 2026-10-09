import type { ControlToAgent, UserId } from "@baize/shared";
import type { Db } from "../db/client.js";

type ConfigBrand = Extract<ControlToAgent, { type: "config" }>["brand"];

/**
 * 第 2 期形状占位：品牌手册随 config 下发的那份。U-品牌 接上 brand_books 表之前恒为 null，
 * 运行器据此当作「没有品牌手册」。
 */
export async function listBrandForConfig(_db: Db, _ownerId: UserId): Promise<ConfigBrand> {
  return null;
}
