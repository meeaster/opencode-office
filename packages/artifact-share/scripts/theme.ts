// Themes for the artifacts site, in the format of OpenCode's desktop themes: a name, an id, and a
// light and a dark variant, each with a palette. The build maps each palette to the site's CSS
// variables, so the browser only picks a variant (light-dark()) and does no colour maths.

/** A colour as lowercase #rrggbb. */
type Hex = `#${string}`;

/** The roles code is coloured by, as OpenCode's `syntax-<role>` overrides name them. */
export const syntaxRoles = ["comment", "keyword", "string", "primitive", "property", "constant", "type", "variable", "operator", "punctuation"] as const;

type SyntaxRole = (typeof syntaxRoles)[number];

type Palette = {
  neutral: Hex;
  ink: Hex;
  primary: Hex;
  success: Hex;
  warning: Hex;
  error: Hex;
  info: Hex;
  accent: Hex | undefined;
  interactive: Hex | undefined;
  diffAdd: Hex | undefined;
  diffDelete: Hex | undefined;
  syntax: Partial<Record<SyntaxRole, Hex>>;
};

export type Theme = { id: string; name: string; light: Palette; dark: Palette };

/** The number of cover colours each theme gives; a card picks one by its name. */
export const toneCount = 6;

const required = ["neutral", "ink", "primary", "success", "warning", "error", "info"] as const;
const optional = ["accent", "interactive", "diffAdd", "diffDelete"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hex(value: unknown, where: string): Hex {
  if (value === undefined) throw new Error(`${where} is missing`);

  if (typeof value !== "string" || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) throw new Error(`${where} must be a colour such as #1d1c1a, not ${JSON.stringify(value)}`);

  const digits = value.slice(1).toLowerCase();

  return `#${digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits}`;
}

function palette(variant: unknown, where: string): Palette {
  if (!isRecord(variant)) throw new Error(`${where} must be an object with a palette`);

  if (!isRecord(variant.palette)) {
    throw new Error(variant.seeds === undefined ? `${where}.palette is missing` : `${where} gives seeds, which this site can't use; give ${where}.palette with ${required.join(", ")}`);
  }

  const colours = variant.palette;
  const optionalHex = (key: (typeof optional)[number]) => (colours[key] === undefined ? undefined : hex(colours[key], `${where}.palette.${key}`));
  const overrides = isRecord(variant.overrides) ? variant.overrides : {};
  const syntax: Palette["syntax"] = {};

  // Of OpenCode's overrides only the syntax colours are used; a role without one is derived from
  // the palette. OpenCode also allows CSS variables and translucent colours there, which the site
  // can't resolve, so those fail like any other value that isn't a plain colour.
  for (const role of syntaxRoles) {
    if (overrides[`syntax-${role}`] !== undefined) syntax[role] = hex(overrides[`syntax-${role}`], `${where}.overrides.syntax-${role}`);
  }

  return {
    neutral: hex(colours.neutral, `${where}.palette.neutral`),
    ink: hex(colours.ink, `${where}.palette.ink`),
    primary: hex(colours.primary, `${where}.palette.primary`),
    success: hex(colours.success, `${where}.palette.success`),
    warning: hex(colours.warning, `${where}.palette.warning`),
    error: hex(colours.error, `${where}.palette.error`),
    info: hex(colours.info, `${where}.palette.info`),
    accent: optionalHex("accent"),
    interactive: optionalHex("interactive"),
    diffAdd: optionalHex("diffAdd"),
    diffDelete: optionalHex("diffDelete"),
    syntax,
  };
}

/**
 * A theme file's content as a theme, or an error naming the problem. `id` is the file's name
 * without `.json`, which the theme's own id must match, since the picker and saved choices use it.
 */
export function parseTheme(data: unknown, id: string): Theme {
  if (!isRecord(data)) throw new Error("it must hold a JSON object");

  if (data.id !== id) throw new Error(`its id is ${JSON.stringify(data.id)}, but the file name gives ${JSON.stringify(id)}; they must match`);

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error("its id must be lowercase letters, digits and single dashes");

  if (typeof data.name !== "string" || data.name.trim() === "") throw new Error("its name must be a non-empty string");

  return { id, name: data.name.trim(), light: palette(data.light, "light"), dark: palette(data.dark, "dark") };
}

type Rgb = [number, number, number];

function rgb(colour: Hex): Rgb {
  const value = Number.parseInt(colour.slice(1), 16);

  return [value >> 16, (value >> 8) & 0xff, value & 0xff];
}

function toHex(channels: Rgb): Hex {
  return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** `from` moved toward `to` by `amount` (0 to 1), mixed in sRGB. */
function mix(from: Hex, to: Hex, amount: number): Hex {
  const a = rgb(from);
  const b = rgb(to);

  return toHex([a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount]);
}

function luminance(colour: Hex): number {
  const [r, g, b] = rgb(colour).map((channel) => {
    const value = channel / 255;

    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two colours, from 1 to 21. */
export function contrast(a: Hex, b: Hex): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);

  return (light + 0.05) / (dark + 0.05);
}

/**
 * The colour, moved toward black on a light background or white on a dark one just far enough to
 * reach the WCAG AA ratio for body text (4.5) against every background, so text stays readable
 * whatever a theme's palette holds.
 */
function readable(colour: Hex, backgrounds: Hex[], dark: boolean): Hex {
  const extreme = dark ? "#ffffff" : "#000000";

  for (let amount = 0; amount <= 1; amount += 0.02) {
    const candidate = mix(colour, extreme, amount);

    if (backgrounds.every((background) => contrast(candidate, background) >= 4.5)) return candidate;
  }

  return extreme;
}

/**
 * The cover colours: the palette's own accent colours, skipping any too close to one already taken
 * so neighbouring cards differ, topped up with blends of them when a palette has fewer than
 * `toneCount` distinct ones.
 */
function tones(colours: Palette): Hex[] {
  const candidates = [colours.primary, colours.accent, colours.success, colours.warning, colours.info, colours.error, colours.interactive, colours.diffAdd, colours.diffDelete];
  const taken: Hex[] = [];

  for (const candidate of candidates) {
    if (candidate === undefined || taken.length === toneCount) continue;

    const close = taken.some((tone) => {
      const a = rgb(tone);
      const b = rgb(candidate);

      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 40;
    });

    if (!close) taken.push(candidate);
  }

  const distinct = taken.length;

  // Halfway between two neighbouring tones gives one more that differs from both.
  for (let i = 0; taken.length < toneCount; i += 1) taken.push(mix(taken[i % distinct] ?? colours.primary, taken[(i + 1) % distinct] ?? colours.primary, 0.5));

  return taken;
}

/** The site's colour variables for one variant of a theme. */
export function variables(colours: Palette, dark: boolean) {
  const paper = colours.neutral;
  const surface = dark ? mix(paper, colours.ink, 0.05) : mix(paper, "#ffffff", 0.7);
  const code = mix(paper, colours.ink, dark ? 0.08 : 0.06);
  const ink = readable(colours.ink, [paper, surface, code], dark);

  // Each cover tone comes with the colour of the large letter set on it: whichever of the page's
  // paper and ink stands out more. Its series colour, for diagrams, is the tone darkened or
  // lightened until text in the paper colour reads on it, as Pele sets a pie's labels.
  const covers = tones(colours).flatMap((tone, index) => [
    [`tone-${index}`, tone],
    [`on-tone-${index}`, contrast(tone, paper) > contrast(tone, ink) ? paper : ink],
    [`series-${index}`, readable(tone, [paper], dark)],
  ]);

  const muted = readable(mix(paper, ink, 0.62), [paper, surface], dark);

  // Where a theme gives no colour for a role, the palette colour OpenCode gives it.
  const derived: Record<SyntaxRole, Hex> = {
    comment: muted,
    keyword: colours.accent ?? colours.primary,
    string: colours.success,
    primitive: colours.primary,
    property: colours.info,
    constant: colours.accent ?? colours.primary,
    type: colours.warning,
    variable: ink,
    operator: dark ? muted : ink,
    punctuation: dark ? muted : ink,
  };

  const syntax = syntaxRoles.map((role) => [`syntax-${role}`, readable(colours.syntax[role] ?? derived[role], [code], dark)]);

  // A changed line is tinted with the theme's diff colour and set in that colour, darkened or
  // lightened until it reads on the tint.
  const diff = ([["add", colours.diffAdd ?? colours.success], ["delete", colours.diffDelete ?? colours.error]] as const).flatMap(([kind, colour]) => {
    const background = mix(code, colour, dark ? 0.2 : 0.16);

    return [
      [`diff-${kind}`, readable(colour, [background], dark)],
      [`diff-${kind}-bg`, background],
    ];
  });

  return {
    paper,
    surface,
    ink,
    muted,
    rule: mix(paper, ink, dark ? 0.16 : 0.14),
    accent: readable(colours.primary, [paper, surface], dark),
    code,
    ...Object.fromEntries(covers),
    ...Object.fromEntries(syntax),
    ...Object.fromEntries(diff),
  };
}

/**
 * The CSS for a theme: its variables on any element with its data-theme, each a light-dark() pair
 * that follows the element's color-scheme, so the page's light, dark or system setting picks one.
 */
export function themeCss(theme: Theme): string {
  // Both variants come from variables(), so their keys are in the same order.
  const dark = Object.entries(variables(theme.dark, true));
  const lines = Object.entries(variables(theme.light, false)).map(([key, light], index) => `  --${key}: light-dark(${light}, ${dark[index]?.[1]});`);

  return `[data-theme="${theme.id}"] {\n${lines.join("\n")}\n}\n`;
}

/**
 * The two tones of an artifact's cover, as indexes into the theme's tones, fixed by its name so a
 * card keeps its colours between builds. Two different tones give 30 pairs, so neighbouring cards
 * rarely share a cover even where they share a first tone.
 */
export function coverTones(name: string): [number, number] {
  // FNV-1a, with the high bits folded in, since its low bits mix poorly for similar names.
  let hash = 0x811c9dc5;

  for (const character of name) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);

  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = (hash ^ (hash >>> 13)) >>> 0;

  const first = hash % toneCount;

  return [first, (first + 1 + (Math.floor(hash / toneCount) % (toneCount - 1))) % toneCount];
}
