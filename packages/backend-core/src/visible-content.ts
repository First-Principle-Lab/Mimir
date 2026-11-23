// Only domains from trusted user messages or this explicit product list may
// occur in model-written links/images. Tool output cannot expand this set.
const PRODUCT_DOMAINS = [
  "github.com",
  "mail.google.com",
  "calendar.google.com",
  "notion.so",
  "www.notion.so",
];
export function visibleDomains(
  userMessages: string[],
  configured = "",
): Set<string> {
  const result = new Set([
    ...PRODUCT_DOMAINS,
    ...configured
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ]);
  for (const message of userMessages) {
    for (const match of message.matchAll(/https?:\/\/[^\s<>"'\])]+/gi)) {
      try {
        result.add(new URL(match[0]).hostname.toLowerCase());
      } catch {
        /* invalid user URL */
      }
    }
  }
  return result;
}
export function sanitizeVisibleText(
  text: string,
  domains: ReadonlySet<string>,
): string {
  const allowed = (raw: string) => {
    try {
      const url = new URL(raw);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        domains.has(url.hostname.toLowerCase())
      );
    } catch {
      return false;
    }
  };
  // Remove raw HTML, protocol-relative and non-web destinations, including
  // tracking images. The renderer also disables raw HTML and remote images.
  return text
    .replace(/<\/?(?:a|img|iframe|video|audio|source|script)\b[^>]*>/gi, "")
    .replace(
      /(!?)\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g,
      (all, image: string, label: string, url: string) =>
        allowed(url) && !image ? all : label,
    )
    .replace(
      /^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?.*$/gm,
      (all, _label: string, url: string) => (allowed(url) ? all : ""),
    )
    .replace(/https?:\/\/[^\s<>"'\])]+/gi, (url) =>
      allowed(url) ? url : "[link removed]",
    );
}
