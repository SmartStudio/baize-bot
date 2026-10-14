import ts from "typescript";

export type MessagesSiteKind = "read" | "write" | "raw_sql" | "query_api" | "unclassified";

export type MessagesSite = {
  readonly line: number;
  /** 最近一层有名字的函数，匿名回调一路往外找。模块顶层是 `<module>`。 */
  readonly fn: string;
  readonly kind: MessagesSiteKind;
  /** read 只在同一条查询链里调了 messageVisibleTo 时放行；write 放行；其余三种一律不放行，只能进白名单。 */
  readonly ok: boolean;
};

const READ_METHODS = new Set(["from", "innerJoin", "leftJoin", "rightJoin", "fullJoin", "crossJoin"]);
const WRITE_METHODS = new Set(["insert", "update", "delete"]);
const COLUMN_MAP_METHODS = new Set(["select", "selectDistinct", "returning"]);

/**
 * 找出一个源文件里所有碰 messages 表的地方。只看语法：从 db/schema 导进来的 `messages`（含 `as` 改名和
 * 命名空间导入）每出现一次都要归类，认不出来的归 unclassified，所以把表赋给别的变量、传给别的函数都躲不过去。
 */
export function scanMessagesTable(fileName: string, text: string): MessagesSite[] {
  return scanTable(fileName, text, "messages", "messages", true);
}

export function scanWorkEntriesTable(fileName: string, text: string): MessagesSite[] {
  return scanTable(fileName, text, "workEntries", "work_entries", false);
}

function scanTable(
  fileName: string,
  text: string,
  table: string,
  sqlTable: string,
  allowViewer: boolean,
): MessagesSite[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const rawTable = new RegExp(`\\b(?:from|join)\\s+(?:"?public"?\\.)?"?${sqlTable}\\b`, "i");
  const tableNames = new Set<string>();
  const schemaNamespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!/(^|\/)schema\.js$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) schemaNamespaces.add(bindings.name.text);
    else
      for (const element of bindings.elements)
        if ((element.propertyName ?? element.name).text === table) tableNames.add(element.name.text);
  }

  const sites: MessagesSite[] = [];
  const add = (node: ts.Node, kind: MessagesSiteKind, ok: boolean) =>
    sites.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      fn: enclosingFunctionName(node),
      kind,
      ok,
    });

  const visit = (node: ts.Node): void => {
    if (ts.isTypeQueryNode(node) || ts.isImportDeclaration(node)) return;
    if (isTableReference(node, tableNames, schemaNamespaces, table)) classifyReference(node, add, allowViewer);
    else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === table &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "query"
    )
      add(node, "query_api", false);
    else if (isStringPart(node) && rawTable.test(node.text)) add(node, "raw_sql", false);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function isTableReference(
  node: ts.Node,
  tableNames: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
  table: string,
): boolean {
  if (ts.isIdentifier(node)) return tableNames.has(node.text) && !isNamePosition(node);
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === table &&
    ts.isIdentifier(node.expression) &&
    namespaces.has(node.expression.text)
  );
}

function isNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    ts.isQualifiedName(parent)
  );
}

function isStringPart(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateHead {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

function calleeName(call: ts.CallExpression): string | null {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;
}

function classifyReference(
  ref: ts.Node,
  add: (node: ts.Node, kind: MessagesSiteKind, ok: boolean) => void,
  allowViewer: boolean,
): void {
  const parent = ref.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === ref) return;
  if (ts.isCallExpression(parent) && parent.arguments[0] === ref) {
    const method = calleeName(parent);
    if (method !== null && READ_METHODS.has(method)) {
      add(ref, "read", allowViewer && callsMessageVisibleTo(queryChain(parent)));
      return;
    }
    if (method !== null && WRITE_METHODS.has(method)) {
      add(ref, "write", true);
      return;
    }
  }
  const mapper = ts.isPropertyAssignment(parent) ? parent.parent.parent : undefined;
  if (mapper !== undefined && ts.isCallExpression(mapper)) {
    const method = calleeName(mapper);
    if (method !== null && COLUMN_MAP_METHODS.has(method)) return;
  }
  add(ref, "unclassified", false);
}

/** 从 `.from(...)` 这一环往外走到整条链的最外层，作为一条查询的范围；作为实参嵌进别的调用里的是另一条链。 */
function queryChain(call: ts.CallExpression): ts.Node {
  let current: ts.Node = call;
  for (;;) {
    const parent: ts.Node = current.parent;
    const continues =
      (ts.isPropertyAccessExpression(parent) && parent.expression === current) ||
      (ts.isCallExpression(parent) && parent.expression === current);
    if (!continues) return current;
    current = parent;
  }
}

function callsMessageVisibleTo(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "messageVisibleTo")
      found = true;
    else ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function enclosingFunctionName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name !== undefined)
      return current.name.getText();
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const owner: ts.Node = current.parent;
      if ((ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner)) && owner.initializer === current)
        return owner.name.getText();
    }
  }
  return "<module>";
}
