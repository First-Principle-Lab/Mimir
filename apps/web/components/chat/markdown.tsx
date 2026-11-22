"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import { cn } from "@/lib/utils";

const WORD_MS = 500;

// react-markdown escapes raw HTML (safe by default), so a `<display_draft>`
// widget block emitted by an assistant would leak its literal tags into the
// chat. Convert the block into a fenced ```draft block and render it as a card
// via the custom `code` component below.
function renderDraftBlocks(content: string): string {
  return content.replace(
    /<display_draft>([\s\S]*?)<\/display_draft>/g,
    (_m, inner: string) => `\n\n\`\`\`draft\n${inner.trim()}\n\`\`\`\n\n`,
  );
}

// A draft block's first line is the title; the rest are `icon field` rows
// (📅 date, 🕚 time, 👤 people, 📍 place). Render as a bordered card. Lines go
// through markdown so assistant emphasis like **bold** renders — bare <p> text
// would literally show the asterisks.
function DraftLine({ text, className }: { text: string; className?: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkBreaks]}
      components={{ p: ({ children }) => <p className={className}>{children}</p> }}
    >
      {text}
    </ReactMarkdown>
  );
}

function DraftCard({ text }: { text: string }) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines.shift();
  return (
    <div className="my-2 rounded-lg border border-border bg-secondary/40 p-3">
      {first ? <DraftLine text={first} className="font-semibold" /> : null}
      {lines.length ? (
        <div className="mt-1 space-y-0.5 text-[0.9rem] text-foreground/80">
          {lines.map((l, i) => (
            <DraftLine key={i} text={l} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const components: Components = {
  // Remote images can leak data even without a click. Keep their alt text.
  img: ({ alt }) => <span>{alt}</span>,
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-1.5 list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>
  ),
  li: ({ children, className, style }) => (
    <li className={className} style={style}>{children}</li>
  ),
  h1: ({ children }) => (
    <h1 className="my-2 text-lg font-semibold first:mt-0 last:mb-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="my-2 text-base font-semibold first:mt-0 last:mb-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="my-1.5 text-[0.975rem] font-semibold first:mt-0 last:mb-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="my-1.5 text-[0.975rem] font-semibold first:mt-0 last:mb-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="my-1.5 text-[0.975rem] font-semibold first:mt-0 last:mb-0">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="my-1.5 text-[0.975rem] font-semibold first:mt-0 last:mb-0">{children}</h6>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-signal underline underline-offset-2"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    const text = Array.isArray(children) ? children.join("") : String(children ?? "");
    // Assistant-emitted draft widget -> a card, not a code block.
    if (/language-draft/.test(className ?? "")) {
      return <DraftCard text={text} />;
    }
    // A fenced block carries a `language-*` class; one without a language still
    // spans newlines, so treat it as a block (rendered in the `pre` below) rather
    // than an inline pill.
    const isBlock = /language-/.test(className ?? "") || text.includes("\n");
    if (isBlock) {
      return <code className={cn(className, "font-mono")}>{children}</code>;
    }
    return (
      <code className="rounded bg-secondary/60 px-1.5 py-0.5 font-mono text-[0.875rem]">
        {children}
      </code>
    );
  },
  pre: ({ children }) => {
    const hasDraftCard = (n: { props?: { className?: string } }) =>
      n?.props?.className?.includes("language-draft");
    // The draft card already renders its own container — don't wrap it in the
    // mono pre box.
    if (hasDraftCard(children as { props?: { className?: string } })) return <>{children}</>;
    return (
      <pre className="my-2 overflow-x-auto rounded-md bg-secondary/60 p-3 text-[0.875rem] leading-6 first:mt-0 last:mb-0">
        {children}
      </pre>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-muted-foreground/40 pl-3 text-muted-foreground first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-[0.875rem]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
  th: ({ children }) => (
    <th className="px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="px-2 py-1 align-top">{children}</td>,
};

type HNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
};

/**
 * rehype plugin: split every text node into .md-word spans so the word-by-word
 * reveal runs *inside* the parsed markdown (bold stays bold, lists stay lists).
 * Code/pre text is left whole and fades in as a unit.
 */
function wordStreamPlugin(active: boolean, wordDelay: number) {
  return () => (tree: HNode) => {
    if (!active) return;
    let index = 0;
    const visit = (node: HNode, inCode: boolean) => {
      if (node.type === "text") {
        const value = node.value ?? "";
        if (inCode || !/\S/.test(value)) return;
        const children: HNode[] = [];
        for (const token of value.split(/(\s+)/)) {
          if (token.length === 0) continue;
          if (/^\s+$/.test(token)) {
            children.push({
              type: "element",
              tagName: "span",
              properties: { className: "md-ws" },
              children: [{ type: "text", value: token }],
            });
          } else {
            children.push({
              type: "element",
              tagName: "span",
              properties: {
                className: "md-word",
                style: `animation-delay: ${index * wordDelay}ms`,
              },
              children: [{ type: "text", value: token }],
            });
            index++;
          }
        }
        node.type = "element";
        node.tagName = "span";
        node.properties = { className: "md-run" };
        node.children = children;
        delete node.value;
      } else if (node.children) {
        const childInCode = inCode || node.tagName === "code" || node.tagName === "pre";
        if (node.tagName === "li") {
          // Sync the list marker (bullet/number) to the first streamed word so
          // the dot fades in together with the text instead of ahead of it.
          const startIndex = index;
          for (const child of node.children) visit(child, childInCode);
          if (startIndex !== index) {
            node.properties = {
              ...node.properties,
              className: "md-li",
              style: `animation-delay: ${startIndex * wordDelay}ms`,
            };
          }
        } else {
          for (const child of node.children) visit(child, childInCode);
        }
      }
    };
    visit(tree, false);
  };
}

/**
 * Render markdown. When `streaming`, words fade in one at a time while the
 * markdown structure stays intact; `onDone` fires once the last word landed.
 */
export function Markdown({
  children,
  streaming = false,
  wordDelay = 55,
  onDone,
  className,
}: {
  children: string;
  streaming?: boolean;
  wordDelay?: number;
  onDone?: () => void;
  className?: string;
}) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const containerRef = useRef<HTMLDivElement | null>(null);

  const content = useMemo(() => renderDraftBlocks(children), [children]);

  useLayoutEffect(() => {
    if (!streaming) return;
    const total = containerRef.current?.querySelectorAll(".md-word").length ?? 0;
    const t = setTimeout(() => doneRef.current?.(), total * wordDelay + WORD_MS + 100);
    return () => clearTimeout(t);
  }, [streaming, children, wordDelay]);

  return (
    <div ref={containerRef} className={cn("break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkBreaks]}
        rehypePlugins={[wordStreamPlugin(streaming, wordDelay)] as never}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
