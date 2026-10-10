import { afterAll, beforeAll, expect, it } from "vitest";
import { helloAgent } from "./helpers/agent.js";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { makeComputer, makeUser } from "./helpers/fixtures.js";

let database: TestDb;
let server: TestServer;

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
});

afterAll(async () => {
  await server.close();
  await database.close();
});

it("config 恒带 preferences 和 brand：没有偏好是空数组，没写过手册是 null，运行器靠它们对账", async () => {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const { agent, config } = await helloAgent(server.server.port, computer.computerId, computer.token);
  try {
    expect(config.preferences).toEqual([]);
    expect(config.brand).toBeNull();
  } finally {
    agent.close();
  }
});
