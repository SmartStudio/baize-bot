import { expect, login, openSettings, test, type Page } from "./fixtures";

const SCRATCH = process.env["E2E_SCRATCH"];

const card = (page: Page, command: string) => page.locator(`[data-testid=cli-tool-card][data-command="${command}"]`);

const openCliTools = async (page: Page) => {
  await login(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-cli").click();
  await expect(page.getByTestId("cli-tools-page")).toBeVisible();
};

const cliRequest = (page: Page, method: string) =>
  page.waitForRequest((request) => request.url().includes("/api/cli-tools") && request.method() === method);

test("预置的 grok 只列变量名和末四位", async ({ page }) => {
  await openCliTools(page);
  const grok = card(page, "grok");
  await expect(grok.getByTestId("cli-tool-install")).toHaveText("npm @vibe-kit/grok-cli");
  await expect(grok.getByTestId("cli-tool-env")).toHaveText("GROK_API_KEY ····WXYZ");
  await expect(grok.getByTestId("cli-tool-where")).toHaveText("云电脑 · 全部 Bot");
  if (SCRATCH !== undefined) await page.screenshot({ path: `${SCRATCH}/cli-tools-list.png`, fullPage: true });
});

test("新增：请求体带值，列表里只见末四位", async ({ page }) => {
  await openCliTools(page);
  const form = page.locator("section.tools-create").getByTestId("cli-tool-form");
  await form.getByTestId("cli-command-input").fill("gemini");
  await form.getByTestId("cli-install-package").fill("@google/gemini-cli");
  await form.getByTestId("cli-env-name").fill("GEMINI_API_KEY");
  await form.getByTestId("cli-env-value").fill("AIza-secret-value-9876");
  await form.getByTestId("cli-computer-local").check();
  await form.getByTestId("cli-bots-all").uncheck();
  await form.locator('[data-testid=cli-bot-checkbox][data-bot-name="小服"]').check();

  const sent = cliRequest(page, "POST");
  await form.getByTestId("cli-save").click();
  expect((await sent).postDataJSON(), "值随请求写进去").toMatchObject({
    command: "gemini",
    install: { manager: "npm", package: "@google/gemini-cli" },
    env: [{ name: "GEMINI_API_KEY", value: "AIza-secret-value-9876" }],
    computers: ["local", "remote"],
    bots: ["bot_service"],
  });

  const gemini = card(page, "gemini");
  await expect(gemini.getByTestId("cli-tool-env")).toHaveText("GEMINI_API_KEY ····9876");
  await expect(gemini.getByTestId("cli-tool-where")).toHaveText("本机、云电脑 · 小服");
  await expect(page.getByTestId("cli-tools-page"), "值不回显").not.toContainText("AIza-secret-value");
  await expect(form.getByTestId("cli-command-input"), "登记完表单清空").toHaveValue("");
});

test("保留变量名被拒，给出中文原因", async ({ page }) => {
  await openCliTools(page);
  const form = page.locator("section.tools-create").getByTestId("cli-tool-form");
  await form.getByTestId("cli-command-input").fill("mytool");
  await form.getByTestId("cli-install-manager").selectOption("none");
  await form.getByTestId("cli-env-name").fill("PATH");
  await form.getByTestId("cli-env-value").fill("/tmp/evil");
  await form.getByTestId("cli-save").click();
  await expect(form.getByTestId("cli-error")).toHaveText("这个变量名会改变别的程序怎么跑，不能登记");
  await expect(card(page, "mytool")).toHaveCount(0);
});

test("编辑：空着的值不发，改了的值进 set，列表换末四位", async ({ page }) => {
  await openCliTools(page);
  const grok = card(page, "grok");
  await grok.getByTestId("cli-tool-edit").click();
  const form = grok.getByTestId("cli-tool-form");
  await expect(form.getByTestId("cli-command-input")).toBeDisabled();
  await expect(form.getByTestId("cli-env-value"), "已存的值不回读").toHaveValue("");

  await form.getByTestId("cli-env-add").click();
  await form.getByTestId("cli-env-name").last().fill("GROK_MODEL");
  await form.getByTestId("cli-env-value").last().fill("grok-4-latest");
  const unchanged = cliRequest(page, "PATCH");
  await form.getByTestId("cli-save").click();
  const first = (await unchanged).postDataJSON() as { set: unknown[] };
  expect(first.set, "没填的 GROK_API_KEY 不发，原样保留").toEqual([{ name: "GROK_MODEL", value: "grok-4-latest" }]);
  await expect(grok.getByTestId("cli-tool-env")).toHaveText("GROK_API_KEY ····WXYZ，GROK_MODEL ····test");

  await grok.getByTestId("cli-tool-edit").click();
  await form
    .locator('[data-testid=cli-env-row][data-env-name="GROK_API_KEY"]')
    .getByTestId("cli-env-value")
    .fill("xai-new-secret-ABCD");
  const changed = cliRequest(page, "PATCH");
  await form.getByTestId("cli-save").click();
  expect(((await changed).postDataJSON() as { set: unknown[] }).set).toEqual([
    { name: "GROK_API_KEY", value: "xai-new-secret-ABCD" },
  ]);
  await expect(grok.getByTestId("cli-tool-env")).toHaveText("GROK_API_KEY ····ABCD，GROK_MODEL ····test");
  await expect(page.getByTestId("cli-tools-page")).not.toContainText("xai-new-secret");
});

test("删变量和删工具都要确认，取消就不动", async ({ page }) => {
  await openCliTools(page);
  const grok = card(page, "grok");
  await grok.getByTestId("cli-tool-edit").click();
  const form = grok.getByTestId("cli-tool-form");

  page.once("dialog", (dialog) => void dialog.dismiss());
  await form.getByTestId("cli-env-remove").click();
  await expect(form.getByTestId("cli-env-row"), "取消了变量还在").toHaveCount(1);

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("GROK_API_KEY");
    void dialog.accept();
  });
  await form.getByTestId("cli-env-remove").click();
  const removed = cliRequest(page, "PATCH");
  await form.getByTestId("cli-save").click();
  expect((await removed).postDataJSON()).toMatchObject({ set: [], remove: ["GROK_API_KEY"] });
  await expect(grok.getByTestId("cli-tool-env")).toHaveText("没有变量");

  page.once("dialog", (dialog) => void dialog.dismiss());
  await grok.getByTestId("cli-tool-delete").click();
  await expect(grok, "取消了工具还在").toHaveCount(1);

  page.once("dialog", (dialog) => void dialog.accept());
  const deleted = cliRequest(page, "DELETE");
  await grok.getByTestId("cli-tool-delete").click();
  await deleted;
  await expect(grok).toHaveCount(0);
});

test("让 Bot 装上：给全部 Bot 的先选人，话发进那个 Bot 的群", async ({ page }) => {
  await openCliTools(page);
  const grok = card(page, "grok");
  await grok.getByTestId("cli-tool-install-ask").click();
  const sent = page.waitForRequest(
    (request) => /\/api\/groups\/[^/]+\/messages$/.test(request.url()) && request.method() === "POST",
  );
  await grok.getByTestId("cli-ask-picker").locator('[data-testid=cli-ask-bot][data-bot-name="小服"]').click();
  const text = "请在云电脑上装命令行工具 grok：npm install -g @vibe-kit/grok-cli。装好后跑一次 `grok --help` 确认。";
  expect((await sent).postDataJSON(), "只走现有的发消息接口").toEqual({ text });

  await expect(page.getByTestId("settings-close"), "发完设置收起").toHaveCount(0);
  await expect(page.getByTestId("chat-title")).toHaveText("小服");
  await expect(page.getByTestId("message-list").getByTestId("message").filter({ hasText: text })).toHaveCount(1);
});

test("让 Bot 装上：只给一个 Bot 的直接发；pip 用 pip install；只在本机的没有按钮", async ({ page }) => {
  await openCliTools(page);
  const form = page.locator("section.tools-create").getByTestId("cli-tool-form");
  await form.getByTestId("cli-command-input").fill("localonly");
  await form.getByTestId("cli-install-package").fill("localonly-cli");
  await form.getByTestId("cli-env-remove").click();
  await form.getByTestId("cli-computer-local").check();
  await form.getByTestId("cli-computer-remote").uncheck();
  await form.getByTestId("cli-save").click();
  await expect(card(page, "localonly").getByTestId("cli-tool-install-ask"), "本机上装要人批，不给按钮").toHaveCount(0);

  await form.getByTestId("cli-command-input").fill("aider");
  await form.getByTestId("cli-install-manager").selectOption("pip");
  await form.getByTestId("cli-install-package").fill("aider-chat");
  await form.getByTestId("cli-env-remove").click();
  await form.getByTestId("cli-bots-all").uncheck();
  await form.locator('[data-testid=cli-bot-checkbox][data-bot-name="小采"]').check();
  await form.getByTestId("cli-save").click();

  await card(page, "aider").getByTestId("cli-tool-install-ask").click();
  await expect(page.getByTestId("chat-title"), "只有一个 Bot 能用，不用选").toHaveText("小采");
  await expect(
    page.getByTestId("message-list").getByTestId("message").filter({
      hasText: "请在云电脑上装命令行工具 aider：pip install aider-chat。装好后跑一次 `aider --help` 确认。",
    }),
  ).toHaveCount(1);
});
