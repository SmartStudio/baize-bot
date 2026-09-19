import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown.js";

describe("Markdown", () => {
  it("renders the supported block and inline syntax", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={
          "# 标题\n\n第一段 **重点** 和 `code`。\n\n- 一项\n- 二项\n\n1. 第一步\n2. 第二步\n\n## 子标题\n### 小标题\n\n```ts\nconst answer = 1;\n```\n\n[文档](https://example.com/docs) 和 https://example.com/help"
        }
      />,
    );

    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<h2>子标题</h2>");
    expect(html).toContain("<h3>小标题</h3>");
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul><li>一项</li><li>二项</li></ul>");
    expect(html).toContain("<ol><li>第一步</li><li>第二步</li></ol>");
    expect(html).toContain('<pre><code data-language="ts">const answer = 1;</code></pre>');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('href="https://example.com/help"');
  });

  it("keeps unfinished streaming text visible and escapes markup", () => {
    const html = renderToStaticMarkup(<Markdown text={"回复还在写 **粗体\n<script>alert(1)</script>"} />);

    expect(html).toContain("回复还在写 **粗体");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
});
