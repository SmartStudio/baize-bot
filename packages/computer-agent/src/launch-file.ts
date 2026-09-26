import { constants } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { AgentLaunch } from "@baize/shared";

export type LaunchFile = { readonly kind: "absent" } | { readonly kind: "taken"; readonly launch: AgentLaunch };

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

/**
 * 普通文件、属主是当前用户、权限正好 600 才读，读完立刻删，token 从此只在内存里。
 * 检查不过就抛中文错误，文件原样留着。检查在打开后的同一个 fd 上做，中途被换成链接也读不到别处。
 */
export async function takeLaunchFile(path: string): Promise<LaunchFile> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    if (errorCode(error) === "ELOOP") throw new Error(`启动文件 ${path} 不是普通文件，是符号链接`, { cause: error });
    throw error;
  }
  let raw: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`启动文件 ${path} 不是普通文件`);
    const uid = process.getuid?.();
    if (stat.uid !== uid) throw new Error(`启动文件 ${path} 的属主必须是当前用户 ${String(uid)}，现在是 ${stat.uid}`);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) throw new Error(`启动文件 ${path} 的权限必须是 600，现在是 ${mode.toString(8)}`);
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  await unlink(path);

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`启动文件 ${path} 不是 JSON，已删除，请重新放一份`);
  }
  const parsed = AgentLaunch.safeParse(json);
  if (!parsed.success) throw new Error(`启动文件 ${path} 不合启动配置的格式，已删除，请重新放一份`);
  return { kind: "taken", launch: parsed.data };
}
