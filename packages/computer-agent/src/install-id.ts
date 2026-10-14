import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export async function loadInstallId(dataDir: string): Promise<string> {
  const directory = join(dataDir, ".agent");
  const path = join(directory, "install-id");
  await mkdir(directory, { recursive: true });
  const read = async (): Promise<string> =>
    z
      .string()
      .uuid()
      .parse((await readFile(path, "utf8")).trim());
  try {
    return await read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const id = randomUUID();
  const temporary = `${path}.${id}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${id}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    // 完整文件再认领，两个代理同时启动也只能保留一个安装标识。
    await link(temporary, path);
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return await read();
  } finally {
    await unlink(temporary);
  }
}
