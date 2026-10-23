import { TEAM_TITLE, expect, login, openBot, openSeededBot, test, type Page } from "./fixtures";

const userTexts = (page: Page) => page.getByTestId("message-list").locator("[data-kind=user]");

const holdNextSend = async (page: Page) => {
  let arrive = () => undefined as void;
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  let release = (_outcome: "pass" | "fail") => undefined as void;
  const released = new Promise<"pass" | "fail">((resolve) => (release = resolve));
  await page.route("**/api/groups/*/messages*", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    arrive();
    if ((await released) === "pass") return route.continue();
    return route.fulfill({ status: 500, json: { error: "上游挂了" } });
  });
  return { arrived, release };
};

const openAssistant = async (page: Page) => {
  await page.getByTestId("assistant-nav").click();
  await expect(page.getByTestId("assistant-nav")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("message-list").getByTestId("message"), "主助理的开场白到了").not.toHaveCount(0);
};

test("输入框草稿按群分存：切到别的群是空的，回车不会把上一个群的草稿发过去，切回来草稿还在", async ({ page }) => {
  await login(page);
  await openBot(page, "小销");
  const input = page.getByTestId("composer-input");
  await input.fill("给 Globex 报价写一半");

  await openAssistant(page);
  await expect(input, "主助理的输入框是它自己的，空着").toHaveValue("");
  const before = await userTexts(page).count();
  await input.press("Enter");
  await input.fill("主助理这边的草稿");
  await openBot(page, "小销");
  await expect(input, "切回小销，草稿还在").toHaveValue("给 Globex 报价写一半");

  await openAssistant(page);
  await expect(input, "主助理的草稿也各自留着").toHaveValue("主助理这边的草稿");
  await expect(userTexts(page), "空输入框回车什么都没发出去").toHaveCount(before);
  await expect(page.getByTestId("message-list"), "小销的草稿没进主助理的群").not.toContainText("给 Globex 报价写一半");
});

test("经过团队页和项目页再回来，草稿还在", async ({ page }) => {
  await login(page);
  await openBot(page, "小销");
  const input = page.getByTestId("composer-input");
  await input.fill("草稿要熬过团队页");

  await page.getByTestId("team-nav").click();
  await expect(page.getByTestId("team-page")).toBeVisible();
  await openBot(page, "小销");
  await expect(input, "从团队页点回来").toHaveValue("草稿要熬过团队页");

  await page.locator("[data-testid=group-item]").first().click();
  await expect(page.getByTestId("project-page")).toBeVisible();
  await openBot(page, "小销");
  await expect(input, "从项目页绕回来").toHaveValue("草稿要熬过团队页");
});

test("项目页的输入框也按群分存，换到别的项目不带过去", async ({ page }) => {
  await login(page);
  await page.getByTestId("new-project").click();
  await page.getByTestId("new-project-input").fill("推广白泽的开源仓库，年底 1000 星");
  await page.getByTestId("new-project-submit").click();
  const offer = page.getByTestId("message-list").getByTestId("project-offer");
  await expect(offer, "主助理回了方案卡").toHaveAttribute("data-status", "offered");
  await offer.getByTestId("project-offer-start").click();
  await expect(page.getByTestId("group-item"), "开出了第二个项目").toHaveCount(2);

  const input = page.getByTestId("project-composer-input");
  await input.fill("新项目写一半");
  await page.locator(`[data-testid=group-item][data-group-title="${TEAM_TITLE}"]`).click();
  await expect(page.getByRole("heading", { name: TEAM_TITLE })).toBeVisible();
  await expect(input, "另一个项目的输入框是空的").toHaveValue("");
  await expect(page.getByTestId("project-composer-send"), "空着就发不出去").toBeDisabled();

  await page.getByTestId("group-item").filter({ hasNotText: TEAM_TITLE }).click();
  await expect(input, "回到新项目，草稿还在").toHaveValue("新项目写一半");
});

test("输入框是多行的：Shift+Enter 换行，Enter 发送，越写越高", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const input = page.getByTestId("composer-input");
  await input.fill("第一行");
  const oneLine = (await input.boundingBox())?.height ?? 0;

  await input.press("Shift+Enter");
  await input.pressSequentially("第二行");
  await input.press("Shift+Enter");
  await input.pressSequentially("第三行");
  await expect(input, "Shift+Enter 只换行不发送").toHaveValue("第一行\n第二行\n第三行");
  expect((await input.boundingBox())?.height ?? 0, "三行比一行高").toBeGreaterThan(oneLine);

  const before = await userTexts(page).count();
  await input.press("Enter");
  await expect(input, "Enter 发送后清空").toHaveValue("");
  await expect(userTexts(page)).toHaveCount(before + 1);
  await expect(userTexts(page).last(), "发出去的是整段三行").toHaveText("第一行\n第二行\n第三行");
  expect((await input.boundingBox())?.height ?? 0, "清空后缩回一行").toBe(oneLine);
});

test("输入法组字时按回车只是上屏，不发送", async ({ page }) => {
  await login(page);
  await openSeededBot(page, "小销");
  const input = page.getByTestId("composer-input");
  await input.focus();
  const before = await userTexts(page).count();

  const cdp = await page.context().newCDPSession(page);
  // 真输入法会把组字时的回车吃掉，页面只看到 keydown，不会多出换行。这里只发 keydown 和 keyup 来模拟。
  const enterKey = async (keyCode: number) => {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: keyCode,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: keyCode,
    });
  };
  await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
  await enterKey(13);
  await cdp.send("Input.insertText", { text: "你" });
  await enterKey(229);
  await expect(input, "组字中的回车没把字发走").toHaveValue("你");

  await input.pressSequentially("好");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(userTexts(page), "只发出了上屏后真按回车的那一条").toHaveCount(before + 1);
  await expect(userTexts(page).last()).toHaveText("你好");
});

test("项目页发出去还没回音就进项目群，回音到了两边输入框都是空的", async ({ page }) => {
  await login(page);
  const send = await holdNextSend(page);
  const project = page.locator("[data-testid=group-item]").first();
  await project.click();
  const projectInput = page.getByTestId("project-composer-input");
  await projectInput.fill("这周多发两条小红书");
  await page.getByTestId("project-composer-send").click();
  await send.arrived;

  await page.getByTestId("project-open-group").click();
  const chatInput = page.getByTestId("composer-input");
  await expect(chatInput).toBeVisible();
  send.release("pass");
  await expect(page.getByTestId("message-list"), "那句话落进了项目群").toContainText("这周多发两条小红书");
  await expect(chatInput, "已经发出去的话不留成项目群的草稿").toHaveValue("");

  await project.click();
  await expect(projectInput, "项目页的输入框也是空的").toHaveValue("");
});

test("聊天里发出去还没回音就去团队页，发失败了回到原群草稿还在", async ({ page }) => {
  await login(page);
  const send = await holdNextSend(page);
  await openBot(page, "小销");
  const input = page.getByTestId("composer-input");
  await input.fill("把 Globex 的报价发出去");
  await input.press("Enter");
  await send.arrived;
  await expect(input).toHaveValue("");

  await page.getByTestId("team-nav").click();
  await expect(page.getByTestId("team-page")).toBeVisible();
  const failed = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.status() === 500,
  );
  send.release("fail");
  await failed;

  await openBot(page, "小销");
  await expect(input, "没发出去的话还回原群").toHaveValue("把 Globex 的报价发出去");
});

test("项目页的输入框也是多行的：Shift+Enter 换行，换行到项目群里还在，Enter 发送", async ({ page }) => {
  await login(page);
  await page.locator("[data-testid=group-item]").first().click();
  const input = page.getByTestId("project-composer-input");
  await input.fill("第一行");
  await input.press("Shift+Enter");
  await input.pressSequentially("第二行");
  await expect(input, "Shift+Enter 只换行不发送").toHaveValue("第一行\n第二行");

  await page.getByTestId("project-open-group").click();
  await expect(page.getByTestId("composer-input"), "项目群里看到的草稿换行还在").toHaveValue("第一行\n第二行");
  await page.locator("[data-testid=group-item]").first().click();

  await input.press("Enter");
  await expect(input, "Enter 发送后清空").toHaveValue("");
  await expect(page.getByTestId("project-latest-turn"), "发出去的是整段两行").toContainText("第一行\n第二行");
});
