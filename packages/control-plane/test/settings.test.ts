import { ApiError, Settings } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeUser } from "./helpers/fixtures.js";

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

async function loggedInClient() {
  const user = await makeUser(database.db);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  return client;
}

describe("设置", () => {
  it("新用户读到的是默认值", async () => {
    const client = await loggedInClient();
    const response = await client.get("/api/settings");

    expect(response.status).toBe(200);
    expect(Settings.parse(await response.json())).toEqual({
      theme: "system",
      notify: true,
      dndFrom: null,
      dndTo: null,
    });
  });

  it("PATCH 只改传了的字段，改完读得回来", async () => {
    const client = await loggedInClient();

    const first = Settings.parse(
      await (await client.patch("/api/settings", { theme: "dark", dndFrom: "22:00", dndTo: "08:00" })).json(),
    );
    expect(first).toEqual({ theme: "dark", notify: true, dndFrom: "22:00", dndTo: "08:00" });

    const second = Settings.parse(await (await client.patch("/api/settings", { notify: false })).json());
    expect(second, "没传的字段保持上一次的值").toEqual({
      theme: "dark",
      notify: false,
      dndFrom: "22:00",
      dndTo: "08:00",
    });

    expect(Settings.parse(await (await client.get("/api/settings")).json())).toEqual(second);
  });

  it("免打扰时段可以清成 null", async () => {
    const client = await loggedInClient();
    await client.patch("/api/settings", { dndFrom: "22:00", dndTo: "08:00" });
    const cleared = Settings.parse(
      await (await client.patch("/api/settings", { dndFrom: null, dndTo: null })).json(),
    );
    expect(cleared.dndFrom).toBeNull();
    expect(cleared.dndTo).toBeNull();
  });

  it("空 PATCH 不改任何东西", async () => {
    const client = await loggedInClient();
    const before = Settings.parse(await (await client.patch("/api/settings", { theme: "light" })).json());
    const after = Settings.parse(await (await client.patch("/api/settings", {})).json());
    expect(after).toEqual(before);
  });

  it("时段格式不对返回 400", async () => {
    const client = await loggedInClient();
    const response = await client.patch("/api/settings", { dndFrom: "晚上十点" });
    expect(response.status).toBe(400);
    ApiError.parse(await response.json());
  });

  it("两个用户的设置互不影响", async () => {
    const one = await loggedInClient();
    const two = await loggedInClient();
    await one.patch("/api/settings", { theme: "dark" });
    expect(Settings.parse(await (await two.get("/api/settings")).json()).theme).toBe("system");
  });
});
