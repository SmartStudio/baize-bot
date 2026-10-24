// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorBoundary } from "./ErrorBoundary.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const Broken = (): never => {
  throw new Error("渲染炸了");
};

describe("ErrorBoundary", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("子组件渲染抛错时换成中文出错页，点重新加载会刷新页面", () => {
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload });

    act(() =>
      root.render(
        <ErrorBoundary>
          <Broken />
        </ErrorBoundary>,
      ),
    );

    const page = host.querySelector('[data-testid="crash-page"]');
    expect(page?.textContent, "出错页用中文说清楚").toContain("页面出错了");
    const button = host.querySelector<HTMLButtonElement>('[data-testid="crash-reload"]');
    expect(button?.textContent).toBe("重新加载");
    act(() => button?.click());
    expect(reload, "按钮真去重新加载").toHaveBeenCalledTimes(1);
  });

  it("没出错时原样画子组件", () => {
    act(() =>
      root.render(
        <ErrorBoundary>
          <p>好好的</p>
        </ErrorBoundary>,
      ),
    );

    expect(host.textContent).toBe("好好的");
  });

  it("resetKey 换了就放开出错页，画新的子组件", () => {
    act(() =>
      root.render(
        <ErrorBoundary resetKey="/a" testId="page-crash">
          <Broken />
        </ErrorBoundary>,
      ),
    );
    expect(host.querySelector('[data-testid="page-crash"]'), "分区边界用自己的 testId").not.toBeNull();

    act(() =>
      root.render(
        <ErrorBoundary resetKey="/b" testId="page-crash">
          <p>别的页</p>
        </ErrorBoundary>,
      ),
    );

    expect(host.querySelector('[data-testid="page-crash"]'), "换了一页出错页就收起").toBeNull();
    expect(host.textContent).toBe("别的页");
  });
});
