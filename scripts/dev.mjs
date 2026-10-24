import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** .env 里的 KEY=value。只认这一种写法，不展开变量也不处理续行。 */
function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    env[match[1]] = match[2].trim().replace(/^["']|["']$/gu, "");
  }
  return env;
}

// 整份 .env 给控制面和 Web，shell 里已经有的变量优先，和 dotenv 的习惯一致。电脑代理不继承 .env，见 agentEnvOf。
const fileEnv = readEnvFile(join(root, ".env"));

const services = [
  { pkg: "@baize/control-plane", dir: "packages/control-plane", port: Number(fileEnv.PORT ?? 3001) },
  { pkg: "@baize/web", dir: "packages/web", port: 5173 },
];

// 电脑代理要一份电脑 token 才连得上控制面，默认不起，免得每次 pnpm dev 都看它报错重连。
function agentService() {
  const missing = ["COMPUTER_ID", "AGENT_TOKEN"].filter((name) => (process.env[name] ?? fileEnv[name] ?? "") === "");
  if (missing.length > 0) {
    console.log(
      `.env 里缺 ${missing.join("、")}，不起 computer-agent。跑 pnpm --filter @baize/control-plane seed 拿一份`,
    );
    return null;
  }
  return { pkg: "@baize/computer-agent", dir: "packages/computer-agent", port: null };
}

const agentEnvKeys = ["COMPUTER_ID", "AGENT_TOKEN", "CONTROL_PLANE_AGENT_URL", "BAIZE_DATA_DIR"];

function agentLaunchOf(envFromFile) {
  const port = process.env.PORT ?? envFromFile.PORT ?? "3001";
  const configuredUrl = process.env.CONTROL_PLANE_AGENT_URL ?? envFromFile.CONTROL_PLANE_AGENT_URL;
  const configuredDataDir = process.env.BAIZE_DATA_DIR ?? envFromFile.BAIZE_DATA_DIR;
  return {
    url: configuredUrl || `ws://127.0.0.1:${port}/agent`,
    computerId: process.env.COMPUTER_ID ?? envFromFile.COMPUTER_ID,
    token: process.env.AGENT_TOKEN ?? envFromFile.AGENT_TOKEN,
    dataDir: configuredDataDir || join(homedir(), ".baize", "bots"),
  };
}

// Bot 的 bash 会继承代理的环境。代理照拿 shell 的环境，但不把 .env 或代理专用变量带进去。
function agentEnvOf(envFromFile) {
  const env = { ...process.env };
  for (const key of Object.keys(envFromFile)) {
    delete env[key];
  }
  for (const key of agentEnvKeys) delete env[key];
  return env;
}

if (process.argv.slice(2).includes("--agent")) {
  const service = agentService();
  if (service !== null) services.push(service);
}

function devScriptOf(dir) {
  const manifest = join(root, dir, "package.json");
  if (!existsSync(manifest)) return null;
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  return typeof parsed.scripts?.dev === "string" ? parsed.scripts.dev : null;
}

function startDatabase() {
  if (!existsSync(join(root, "docker-compose.yml"))) {
    console.log("跳过 PostgreSQL：根目录没有 docker-compose.yml");
    return;
  }
  const result = spawnSync("docker", ["compose", "up", "-d"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) console.log("docker compose up -d 没成功，控制面可能连不上库");
}

function prefixed(name, stream, write) {
  let rest = "";
  stream.on("data", (chunk) => {
    const lines = (rest + chunk.toString()).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) write(`[${name}] ${line}\n`);
  });
  // 崩溃时最后一行常常没有换行，不刷就把最有用的那句丢了。
  stream.on("end", () => {
    if (rest !== "") write(`[${name}] ${rest}\n`);
    rest = "";
  });
}

startDatabase();

let stopping = false;
const children = [];
for (const service of services) {
  const name = service.pkg.replace("@baize/", "");
  if (devScriptOf(service.dir) === null) {
    console.log(`跳过 ${name}：${service.dir} 还没有带 dev 脚本的 package.json`);
    continue;
  }
  const isAgent = service.pkg === "@baize/computer-agent";
  const env = isAgent
    ? agentEnvOf(fileEnv)
    : { ...(service.pkg === "@baize/control-plane" ? { LOG_FORMAT: "pretty" } : {}), ...fileEnv, ...process.env };
  // 启动报文必须直接交给代理入口；代理的 dev 脚本也不热重载。
  const args = isAgent ? ["--filter", service.pkg, "exec", "tsx", "src/main.ts"] : ["--filter", service.pkg, "dev"];
  const child = spawn("pnpm", args, {
    cwd: root,
    stdio: [isAgent ? "pipe" : "ignore", "pipe", "pipe"],
    env,
  });
  if (isAgent) {
    child.stdin.on("error", (error) => console.error(`[${name}] stdin 写入失败：${error.message}`));
    child.stdin.write(`${JSON.stringify(agentLaunchOf(fileEnv))}\n`);
  }
  prefixed(name, child.stdout, (line) => process.stdout.write(line));
  prefixed(name, child.stderr, (line) => process.stderr.write(line));
  child.on("exit", (code, signal) => {
    console.log(`[${name}] 退出，code ${code ?? signal}`);
    children.splice(children.indexOf(child), 1);
    if (children.length === 0) process.exit(stopping ? 0 : (code ?? 1));
  });
  children.push(child);
  console.log(`起 ${name}${service.port === null ? "" : `，端口 ${service.port}`}`);
}

if (children.length === 0) {
  console.log("一个服务都没起来，等别的包就位再跑 pnpm dev");
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // 第二次信号是「有子进程不肯退」，别陪着挂死。
    if (stopping) process.exit(1);
    stopping = true;
    for (const child of children) child.kill(signal);
  });
}
