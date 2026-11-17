/**
 * Rendered Markdown with every link and image address that could run script (javascript:,
 * vbscript:, data: and any other scheme but http, https and mailto) removed, so the link shows as
 * plain text and the image as its alt text. Relative and fragment addresses stay. It reads only
 * the <a> and <img> tags Bun's renderer writes when raw HTML is off, whose attribute values are
 * double-quoted and entity-escaped.
 */
export function safeLinks(html: string): string {
  return html.replaceAll(/<(?:a|img)\s[^>]*>/g, (tag) =>
    tag.replaceAll(/\s(?:href|src)="([^"]*)"/g, (attribute, value: string) => {
      const address = value
        .replaceAll(/&#x([0-9a-f]+);?/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replaceAll(/&#(\d+);?/g, (_, code: string) => String.fromCodePoint(Number(code)))
        .replaceAll("&amp;", "&")
        // Browsers ignore control characters and spaces around and inside a scheme.
        .replaceAll(/[\u0000- ]/g, "");

      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(address)?.[1]?.toLowerCase();

      return scheme === undefined || scheme === "http" || scheme === "https" || scheme === "mailto" ? attribute : "";
    }),
  );
}
