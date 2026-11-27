// The exact pins in an office's mise.toml files, read and rewritten as text, so every comment and
// the layout stay as written.

// A [tools] entry: `name = "1.2.3"` or `name = { version = "1.2.3", ... }`, name optionally quoted.
export const entryPattern = /^(\s*)("[^"]+"|[A-Za-z0-9_.:@/-]+)(\s*=\s*(?:\{[^}]*?\bversion\s*=\s*)?")([^"]+)(".*)$/;

/** The pins in a mise.toml's [tools] table, with the line each is on. */
export function toolPins(text: string): { index: number; tool: string; version: string }[] {
  let inTools = false;

  return text.split("\n").flatMap((line, index) => {
    if (/^\s*\[/.test(line)) inTools = /^\s*\[tools\]\s*(#.*)?$/.test(line);

    const match = inTools ? entryPattern.exec(line) : null;

    return match === null ? [] : [{ index, tool: match[2].replaceAll('"', ""), version: match[4] }];
  });
}
