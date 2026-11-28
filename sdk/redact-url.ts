/** `text` with the user information of every URL in it replaced. */
export function redactUrl(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]+@/gi, "$1***@");
}
