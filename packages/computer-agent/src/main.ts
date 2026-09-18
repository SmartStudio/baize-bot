import { ComputerId } from "@baize/shared";
import { startAgent } from "./agent.js";

const AGENT_VERSION = "0.1.0";

const handle = startAgent({
  url: process.env["CONTROL_PLANE_AGENT_URL"] ?? "ws://localhost:3001/agent",
  computerId: ComputerId.parse(process.env["COMPUTER_ID"] ?? "dev-computer"),
  token: process.env["AGENT_TOKEN"] ?? "dev-token",
  version: AGENT_VERSION,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handle.stop().finally(() => process.exit(0));
  });
}
