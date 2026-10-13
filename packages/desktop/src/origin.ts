const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isSecureTransport(url: URL): boolean {
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname.replace(/^\[(.*)\]$/u, "$1")))
  );
}

export function normalizedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("控制面地址必须是有效的 http 或 https 地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("控制面地址只支持 http 或 https");
  if (!isSecureTransport(url)) throw new Error("远程控制面必须使用 https");
  return url.origin;
}
