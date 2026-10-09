import { EMAIL, PASSWORD, expect, test, Message, MessageListResponse, login, openBot, sendText } from "./fixtures";

const HISTORY = "**/api/groups/grp_sales/messages*";

const held = () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
};

test("登出再登录后，旧会话在途的群历史被取消、不写进新会话，新会话重新拉历史", async ({ page }) => {
  const LEAK = "旧会话历史泄漏进新会话";
  const oldResponse = held();
  let oldSettled: Promise<void> = Promise.resolve();
  let historyRequests = 0;
  const cancelled: string[] = [];
  page.on("requestfailed", (request) => {
    if (request.method() === "GET" && request.url().includes("/api/groups/grp_sales/messages"))
      cancelled.push(request.url());
  });
  await page.route(HISTORY, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    historyRequests += 1;
    if (historyRequests > 1) return route.continue();
    const response = await route.fetch();
    const payload = MessageListResponse.parse(await response.json());
    const groupId = payload.messages[0]?.groupId;
    if (groupId === undefined) throw new Error("小销的预置对话没有消息");
    const leak = Message.parse({
      id: "message_old_session",
      groupId,
      body: { kind: "user", text: LEAK },
      createdAt: new Date().toISOString(),
      revision: 0,
    });
    oldSettled = oldResponse.gate.then(() =>
      route.fulfill({ response, json: { ...payload, messages: [...payload.messages, leak] } }).catch(() => undefined),
    );
    await oldSettled;
  });

  await login(page);
  await openBot(page, "小销");
  await expect.poll(() => historyRequests, "旧会话的历史请求已经发出").toBe(1);

  await page.getByTestId("account-button").click();
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("login")).toBeVisible();
  // 不刷新页面，同一个 AppProvider 里重新登录。
  await page.getByTestId("email-input").fill(EMAIL);
  await page.getByTestId("password-input").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("main-window")).toBeVisible();

  oldResponse.release();
  await oldSettled;

  await openBot(page, "小销");
  const list = page.getByTestId("message-list");
  await expect(list.getByTestId("message"), "新会话的历史到了").not.toHaveCount(0);
  expect(historyRequests, "新会话重新拉了这个群的历史").toBe(2);
  await expect(list, "新会话不显示旧会话回包里的消息").not.toContainText(LEAK);
  expect(cancelled, "登出时旧会话在途的历史请求被取消").toHaveLength(1);
});

test("刚进群、历史还在路上时发出的消息，历史到了以后还在对话区", async ({ page }) => {
  const TEXT = "历史还没到我就先说一句";
  const history = held();
  const read = held();
  await page.route(HISTORY, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    // 服务端先读到发消息之前的历史，回包再压到消息发出之后。
    const response = await route.fetch();
    const payload = MessageListResponse.parse(await response.json());
    read.release();
    await history.gate;
    await route.fulfill({ response, json: payload });
  });

  await login(page);
  await openBot(page, "小销");
  await read.gate;
  const posted = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().includes("/api/groups/grp_sales/messages"),
  );
  await sendText(page, TEXT);
  expect((await posted).ok(), "消息发出去了").toBe(true);
  history.release();

  const list = page.getByTestId("message-list");
  await expect(list.getByTestId("message"), "历史到了").not.toHaveCount(0);
  // Bot 的回复会复述这句话的开头，只数用户自己的消息。
  await expect(list.locator("[data-kind=user]", { hasText: TEXT }), "历史在路上时发出的消息还在").toHaveCount(1);
});
