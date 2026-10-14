import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const HOME = "agent/place-run.ts";

function runCreationSites(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tables = new Set(["runs"]);
  const starters = new Set(["startRun"]);
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === "runs") tables.add(element.name.text);
        if (imported === "startRun") starters.add(element.name.text);
      }
  }
  const sites: string[] = [];
  const add = (node: ts.Node, kind: string): void => {
    sites.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${kind}`);
  };
  const isTable = (node: ts.Node | undefined): boolean =>
    node !== undefined &&
    ((ts.isIdentifier(node) && tables.has(node.text)) ||
      (ts.isPropertyAccessExpression(node) &&
        node.name.text === "runs" &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text)));
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "insert" && isTable(node.arguments[0]))
        add(node, "insert(runs)");
      if (
        (ts.isIdentifier(callee) && starters.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "startRun")
      )
        add(node, "startRun()");
    }
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      /\binsert\s+into\s+(?:"?public"?\.)?"?runs\b/i.test(node.text)
    )
      add(node, "INSERT INTO runs");
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

describe("建 run 只走 placeRun", () => {
  it("控制面 src 里其余文件不能直接写 runs 或调用 startRun", () => {
    const files = readdirSync(SRC, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".ts") && file !== HOME)
      .toSorted();
    expect(
      files.flatMap((file) => runCreationSites(file, readFileSync(SRC + file, "utf8"))),
      "这些入口跳过了租约认领和可靠 prompt 入队，必须改走 agent/place-run.ts",
    ).toEqual([]);
    expect(runCreationSites(HOME, readFileSync(SRC + HOME, "utf8")), "唯一入口必须实际建 run").not.toEqual([]);
  });

  it("多行 drizzle insert、改名和命名空间导入都会被发现", () => {
    const text = `import { runs as records } from "../db/schema.js";
      import * as schema from "../db/schema.js";
      db
        .insert(
          records,
        ).values({});
      tx.insert(schema.runs).values({});`;
    expect(runCreationSites("probe.ts", text)).toHaveLength(2);
  });

  it("直接和改名调用 startRun、手写 SQL 都会被发现", () => {
    const text = `import { startRun as begin } from "../repo/runs.js";
      startRun(tx, input);
      begin(tx, input);
      repo.startRun(tx, input);
      db.execute(sql\`INSERT INTO public.runs (id) VALUES ('r')\`);`;
    expect(runCreationSites("probe.ts", text)).toHaveLength(4);
  });

  it("收尾、查库、函数声明、注释和其他表的写入不算建 run", () => {
    const text = `import { runs } from "../db/schema.js";
      function startRun() {}
      // db.insert(runs).values({});
      db.select().from(runs);
      db.update(runs).set({ endedAt: new Date() });
      db.insert(messages).values({});`;
    expect(runCreationSites("probe.ts", text)).toEqual([]);
  });
});
