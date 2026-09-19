import type { ReactNode } from "react";

const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/g;

const inline = (text: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index;
    if (start > at) nodes.push(text.slice(at, start));
    const [whole, bold, code, label, destination, bareUrl] = match;
    if (bold !== undefined) nodes.push(<strong key={start}>{bold}</strong>);
    else if (code !== undefined) nodes.push(<code key={start}>{code}</code>);
    else if (label !== undefined && destination !== undefined)
      nodes.push(
        <a key={start} href={destination} target="_blank" rel="noopener noreferrer">
          {label}
        </a>,
      );
    else if (bareUrl !== undefined) {
      const url = bareUrl.replace(/[.,!?，。！？]+$/, "");
      nodes.push(
        <a key={start} href={url} target="_blank" rel="noopener noreferrer">
          {url}
        </a>,
      );
      if (url.length < bareUrl.length) nodes.push(bareUrl.slice(url.length));
    }
    at = start + whole.length;
  }
  if (at < text.length) nodes.push(text.slice(at));
  return nodes;
};

const heading = /^(#{1,3})\s+(.+)$/;
const listItem = /^(?:-|\d+\.)\s+(.+)$/;
const orderedItem = /^\d+\.\s+/;

export const Markdown = ({ text }: { text: string }) => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let at = 0;

  while (at < lines.length) {
    const line = lines[at] ?? "";
    if (line.trim() === "") {
      at += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      at += 1;
      while (at < lines.length && !lines[at]?.startsWith("```")) {
        code.push(lines[at] ?? "");
        at += 1;
      }
      if (at < lines.length) at += 1;
      blocks.push(
        <pre key={blocks.length}>
          <code data-language={language || undefined}>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const title = heading.exec(line);
    if (title !== null) {
      const content = inline(title[2] ?? "");
      if (title[1]?.length === 1) blocks.push(<h1 key={blocks.length}>{content}</h1>);
      else if (title[1]?.length === 2) blocks.push(<h2 key={blocks.length}>{content}</h2>);
      else blocks.push(<h3 key={blocks.length}>{content}</h3>);
      at += 1;
      continue;
    }
    if (listItem.test(line)) {
      const ordered = orderedItem.test(line);
      const items: ReactNode[] = [];
      while (at < lines.length) {
        const current = lines[at] ?? "";
        const match = listItem.exec(current);
        if (match === null || orderedItem.test(current) !== ordered) break;
        items.push(<li key={items.length}>{inline(match[1] ?? "")}</li>);
        at += 1;
      }
      blocks.push(ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
      continue;
    }
    const paragraph: string[] = [line];
    at += 1;
    while (at < lines.length) {
      const current = lines[at] ?? "";
      if (current.trim() === "" || current.startsWith("```") || heading.test(current) || listItem.test(current)) break;
      paragraph.push(current);
      at += 1;
    }
    blocks.push(<p key={blocks.length}>{inline(paragraph.join("\n"))}</p>);
  }

  return <div className="markdown">{blocks}</div>;
};
