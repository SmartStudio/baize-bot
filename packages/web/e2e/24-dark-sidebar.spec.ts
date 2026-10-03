import { login, openSettings, test, expect, type Page } from "./fixtures";

// 浏览器算出来的 rgb()/rgba() 逐层叠到不透明为止，再按 WCAG 相对亮度算对比度。
const contrastOf = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      type Rgba = [number, number, number, number];
      const parse = (value: string): Rgba => {
        const m = value.match(/rgba?\(([^)]+)\)/);
        if (m === null || m[1] === undefined) throw new Error(`读不出颜色：${value}`);
        const p = m[1]
          .split(/[ ,/]+/)
          .filter((s) => s !== "")
          .map(Number);
        return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
      };
      const over = (top: Rgba, under: Rgba): Rgba => {
        const a = top[3] + under[3] * (1 - top[3]);
        const mix = (i: 0 | 1 | 2) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
        return [mix(0), mix(1), mix(2), a];
      };
      const layers: Rgba[] = [];
      for (let node: Element | null = el; node !== null; node = node.parentElement) {
        layers.push(parse(getComputedStyle(node).backgroundColor));
      }
      const bg = layers.reduceRight<Rgba>((under, layer) => over(layer, under), [255, 255, 255, 1]);
      const fg = over(parse(getComputedStyle(el).color), bg);
      const lum = ([r, g, b]: Rgba) => {
        const lin = (c: number) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const [hi, lo] = [Math.max(lum(fg), lum(bg)), Math.min(lum(fg), lum(bg))];
      return { ratio: (hi + 0.05) / (lo + 0.05), fg: fg.map(Math.round).join(","), bg: bg.map(Math.round).join(",") };
    });

const SELECTED_TEXT = [
  "[data-testid=today-nav][aria-current=page]",
  "[data-testid=assistant-nav][aria-current=page]",
  "[data-testid=routines-nav][aria-current=page]",
  "[data-testid=team-nav][aria-current=page]",
  "[data-testid=group-item][aria-current=page] b",
  "[data-testid=group-item][aria-current=page] small",
];

const clickThroughSelected = async (page: Page) => {
  await page.addStyleTag({ content: "*{transition:none !important}" });
  for (const id of ["today-nav", "assistant-nav", "routines-nav", "team-nav", "group-item"]) {
    await page.getByTestId(id).click();
    await expect(page.locator(`[data-testid=${id}][aria-current=page]`), `${id} 点亮`).toHaveCount(1);
    for (const selector of SELECTED_TEXT.filter((s) => s.startsWith(`[data-testid=${id}]`))) {
      const { ratio, fg, bg } = await contrastOf(page, selector);
      expect(ratio, `${selector} 文字 rgb(${fg}) 压在 rgb(${bg}) 上`).toBeGreaterThanOrEqual(4.5);
    }
  }
};

test.describe("系统深色", () => {
  test.use({ colorScheme: "dark" });
  test("侧栏选中项的文字和背景对比度不低于 4.5", async ({ page }) => {
    await login(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await clickThroughSelected(page);
  });
});

test.describe("系统浅色、设置里选深色", () => {
  test.use({ colorScheme: "light" });
  test("侧栏选中项的文字和背景对比度不低于 4.5", async ({ page }) => {
    await login(page);
    await openSettings(page);
    await page.getByTestId("theme-select").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByTestId("settings-close").click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await clickThroughSelected(page);
  });
});
