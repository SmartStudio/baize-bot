import { expect, test, EMAIL, SHOT, fillCredentials, login, teamCard } from "./fixtures";

test("注册页注册后进首页", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("register-link").click();
  await page.getByTestId("register-email").fill("new-user@baize.dev");
  await page.getByTestId("register-password").fill("new-user-password");
  await page.getByTestId("register-name").fill("林舟");
  await page.evaluate(() => {
    (window as Window & { __registerPage?: boolean }).__registerPage = true;
  });
  await page.getByTestId("register-submit").click();
  await expect(page.getByTestId("main-window")).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __registerPage?: boolean }).__registerPage)).toBe(true);
});

test("重复邮箱注册，表单里显示已被占用", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("register-link").click();
  await page.getByTestId("register-email").fill(EMAIL);
  await page.getByTestId("register-password").fill("new-user-password");
  await page.getByTestId("register-name").fill("陈默");
  await page.getByTestId("register-submit").click();
  await expect(page.getByTestId("register-error")).toHaveText("这个邮箱已经注册过了");
  expect(new URL(page.url()).pathname).toBe("/register");
});

test("登录页没有企业和同事", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("login")).toBeVisible();
  await expect(page.getByTestId("login")).not.toContainText("企业");
  await expect(page.getByTestId("login")).not.toContainText("同事");
});

test("密码不对时登录页留在原地并说明原因", async ({ page }) => {
  await fillCredentials(page, "wrong-password");
  await expect(page.getByTestId("login-error")).toHaveText("邮箱或密码不对");
  await expect(page.getByTestId("main-window")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/login");
  await page.screenshot({ path: `${SHOT}/01.png` });
});

test("登录试太多次被挡时，登录页说多久后再试，按钮还能再点", async ({ page }) => {
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      status: 429,
      headers: { "retry-after": "840" },
      contentType: "application/json",
      body: JSON.stringify({ error: "尝试太多次了，请 14 分钟后再试" }),
    }),
  );
  await fillCredentials(page, "wrong-password");
  await expect(page.getByTestId("login-error")).toHaveText("尝试太多次了，请 14 分钟后再试");
  await expect(page.getByTestId("login-submit")).toBeEnabled();
  expect(new URL(page.url()).pathname).toBe("/login");
});

test("注册太频繁被挡时，注册页说多久后再试", async ({ page }) => {
  await page.route("**/api/register", (route) =>
    route.fulfill({
      status: 429,
      headers: { "retry-after": "3600" },
      contentType: "application/json",
      body: JSON.stringify({ error: "尝试太多次了，请 60 分钟后再试" }),
    }),
  );
  await page.goto("/register");
  await page.getByTestId("register-email").fill("new-user@baize.dev");
  await page.getByTestId("register-password").fill("new-user-password");
  await page.getByTestId("register-name").fill("林舟");
  await page.getByTestId("register-submit").click();
  await expect(page.getByTestId("register-error")).toHaveText("尝试太多次了，请 60 分钟后再试");
  expect(new URL(page.url()).pathname).toBe("/register");
});

test("登录成功进主窗口，团队页列出预置的三个 Bot", async ({ page }) => {
  await login(page);
  await page.getByTestId("team-nav").click();
  const names = page.getByTestId("team-bot");
  await expect(names).toHaveCount(3);
  for (const name of ["小服", "小销", "小采"]) {
    await expect(teamCard(page, name)).toHaveCount(1);
  }
  await page.screenshot({ path: `${SHOT}/02.png` });
});
