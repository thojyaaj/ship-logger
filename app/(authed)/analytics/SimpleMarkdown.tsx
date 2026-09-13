import type { ReactNode } from "react";

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== "");
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={`${keyPrefix}-${i}`} className="font-semibold text-ink">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={`${keyPrefix}-${i}`}>{part}</span>
    ),
  );
}

/**
 * Minimal, dependency-free renderer for the handful of markdown constructs
 * lib/ai-insights.ts's prompt actually asks Claude to produce (##/###
 * headings, **bold**, "- "/"1. " lists, blank-line paragraphs) — not a
 * general markdown parser, just enough so the raw AI output doesn't show
 * literal `**` and `##` characters to the reader.
 */
export default function SimpleMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const k = key++;
      blocks.push(
        level <= 2 ? (
          <h3 key={k} className="font-stencil text-base tracking-wide mt-1 first:mt-0">
            {renderInline(heading[2], `h${k}`)}
          </h3>
        ) : (
          <h4 key={k} className="font-semibold text-sm mt-1">
            {renderInline(heading[2], `h${k}`)}
          </h4>
        ),
      );
      i++;
      continue;
    }

    const isOrderedLine = (l: string) => l.match(/^\s*\d+\.\s+(.*)$/);
    const isBulletLine = (l: string) => l.match(/^\s*[-*]\s+(.*)$/);
    const orderedItem = isOrderedLine(line);
    const bulletItem = isBulletLine(line);
    if (orderedItem || bulletItem) {
      const isOrdered = !!orderedItem;
      const items: string[] = [];
      while (i < lines.length) {
        const m = isOrdered ? isOrderedLine(lines[i]) : isBulletLine(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      const k = key++;
      blocks.push(
        isOrdered ? (
          <ol key={k} className="pl-5 flex flex-col gap-1 list-decimal">
            {items.map((item, idx) => (
              <li key={idx}>{renderInline(item, `li${k}-${idx}`)}</li>
            ))}
          </ol>
        ) : (
          <ul key={k} className="pl-5 flex flex-col gap-1 list-disc">
            {items.map((item, idx) => (
              <li key={idx}>{renderInline(item, `li${k}-${idx}`)}</li>
            ))}
          </ul>
        ),
      );
      continue;
    }

    // Paragraph — consume consecutive non-blank, non-list, non-heading lines as one block.
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].match(/^#{1,3}\s+/) && !isOrderedLine(lines[i]) && !isBulletLine(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    const k = key++;
    blocks.push(<p key={k}>{renderInline(paraLines.join(" "), `p${k}`)}</p>);
  }

  return <div className="flex flex-col gap-2">{blocks}</div>;
}
