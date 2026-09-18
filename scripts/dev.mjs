import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const AGENT_KEYS = ["COMPUTER_ID", "AGENT_TOKEN", "CONTROL_PLANE_AGENT_URL", "BAIZE_DATA_DIR"];

const services = [
  { pkg: "@baize/control-plane", dir: "packages/control-plane", port: 3001 },
  { pkg: "@baize/web", dir: "packages/web", port: 5173 },
];

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

// 电脑代理要一份电脑 token 才连得上控制面，默认不起，免得每次 pnpm dev 都看它报错重连。
function agentService() {
  const env = readEnvFile(join(root, ".env"));
  const missing = ["COMPUTER_ID", "AGENT_TOKEN"].filter((name) => (env[name] ?? "") === "");
  if (missing.length > 0) {
    console.log(
      `.env 里缺 ${missing.join("、")}，不起 computer-agent。跑 pnpm --filter @baize/control-plane seed 拿一份`,
    );
    return null;
  }
  const picked = {};
  for (const key of AGENT_KEYS) if ((env[key] ?? "") !== "") picked[key] = env[key];
  return { pkg: "@baize/computer-agent", dir: "packages/computer-agent", port: null, env: picked };
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
  const child = spawn("pnpm", ["--filter", service.pkg, "dev"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...service.env },
  });
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
