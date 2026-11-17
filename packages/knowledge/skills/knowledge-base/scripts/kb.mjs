#!/usr/bin/env bun
// Adapted from Cairn's knowledge-base checker. Bun with built-in modules only.
//
//   kb.mjs init <folder> [--name NAME]
//   kb.mjs check <folder>
//   kb.mjs stale <folder> [--article PATH] [--older-than DAYS]
//   kb.mjs migrate <folder>

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Format 2 keeps each article's references in references/<subject>.md, out of the article lookups read.
const format = "2";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const date = /^\d{4}-\d{2}-\d{2}$/;

const originKeyPattern = /^[a-z][a-z0-9-]*:\S+$/;

const linkPattern = /\[[^\]]*\]\(([^)\s]+)\)/g;

const headingPattern = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

const numbered = /^\d+\.\s+(.*)$/;

// Where each kind of source lives under sources/. A kind not listed here gets a folder named for it.
const sourceFolders = { meeting: "meetings", email: "email", chat: "chat", ticket: "tickets", page: "pages", statement: "statements" };

const threads = new Set(["email", "chat", "ticket"]);

const message = /^## \d{4}-\d{2}-\d{2}( \d{2}:\d{2})? · /;

function report() {
  const errors = [];
  const warnings = [];

  return {
    errors,
    warnings,
    error: (where, text) => errors.push(`${where}: ${text}`),
    warn: (where, text) => warnings.push(`${where}: ${text}`)
  };
}

// A Markdown file's front matter and the lines after it.
function read(path) {
  let lines = readFileSync(path, "utf8").split(/\r?\n/);
  const meta = new Map();

  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

    if (end !== -1) {
      for (const line of lines.slice(1, end)) {
        const colon = line.indexOf(":");

        if (colon > 0) {
          meta.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
        }
      }

      lines = lines.slice(end + 1);
    }
  }

  return { path, meta, lines };
}

function headings(doc) {
  const found = [];
  let fenced = false;

  doc.lines.forEach((line, index) => {
    if (line.startsWith("```")) {
      fenced = !fenced;

      return;
    }

    const match = fenced ? null : headingPattern.exec(line);

    if (match !== null) {
      found.push({ level: match[1].length, text: match[2], index });
    }
  });

  return found;
}

// The lines under a ## heading, up to the next ## or # heading, or null when there's no such heading.
function section(doc, title) {
  const all = headings(doc);
  const position = all.findIndex((heading) => heading.level === 2 && heading.text === title);

  if (position === -1) {
    return null;
  }

  const next = all.slice(position + 1).find((heading) => heading.level <= 2);

  return doc.lines.slice(all[position].index + 1, next === undefined ? doc.lines.length : next.index);
}

function markdownFiles(folder) {
  if (!existsSync(folder)) {
    return [];
  }

  const found = [];

  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);

    if (entry.isDirectory()) {
      found.push(...markdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(path);
    }
  }

  return found.sort();
}

const rel = (root, path) => relative(root, path).split(sep).join("/");

function requireMeta(out, where, doc, key, isDate = false) {
  const value = doc.meta.get(key) ?? "";

  if (value === "") {
    out.error(where, `front matter needs \`${key}:\``);
  } else if (isDate && !date.test(value)) {
    out.error(where, `\`${key}:\` must be a date like 2026-10-19, not '${value}'`);
  }
}

// Resolves a relative link from a file, reporting links that leave the knowledge base or point at nothing.
function resolveLink(out, root, where, source, target) {
  if ((/^[a-z]+:\/\//.test(target) && !target.startsWith("file://")) || target.startsWith("#") || target.startsWith("mailto:")) {
    return null;
  }

  const outside = `link to ${target} is outside the knowledge base; copy it in as evidence`;

  if (target.startsWith("file://") || target.startsWith("/") || target.startsWith("~")) {
    out.error(where, outside);

    return null;
  }

  const path = resolve(dirname(source), target.split("#")[0]);
  const fromRoot = relative(root, path);

  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    out.error(where, outside);

    return null;
  }

  if (!existsSync(path)) {
    out.error(where, `link to ${target} points at nothing`);

    return null;
  }

  return path;
}

function loadOrigins(root, out) {
  const origins = new Map();
  const path = join(root, "origins.md");

  if (!existsSync(path)) {
    out.error("origins.md", "missing; `init` creates it");

    return origins;
  }

  const doc = read(path);
  let current = null;

  for (const line of doc.lines) {
    const match = headingPattern.exec(line);

    if (match !== null && match[1].length === 2) {
      const key = match[2].replaceAll("`", "");

      current = null;

      if (!originKeyPattern.test(key)) {
        out.error("origins.md", `heading '${match[2]}' isn't an origin key like \`aws:123456789012\``);
      } else if (origins.has(key)) {
        out.error("origins.md", `origin ${key} is listed twice`);
      } else {
        origins.set(key, []);
        current = key;
      }
    } else if (current !== null && line.trim() !== "") {
      origins.get(current).push(line.trim());
    }
  }

  for (const [key, body] of origins) {
    if (!body.some((line) => /^-?\s*access:/i.test(line))) {
      out.warn("origins.md", `origin ${key} says nothing about how to reach it (\`- Access:\`)`);
    }
  }

  return origins;
}

const splitParts = (item) => item.split(" · ").map((part) => part.trim());

const originKey = (part) => /^`([^`]+)`$/.exec(part)?.[1] ?? null;

const links = (text) => [...text.matchAll(linkPattern)].map((match) => match[1]);

const topFolder = (root, path) => rel(root, path).split("/")[0];

function checkReference(out, root, where, doc, item, origins, sectionNames, cited) {
  const parts = splitParts(item);
  const key = originKey(parts[0]);
  let rest = parts.slice(1);

  if (key !== null) {
    if (!origins.has(key)) {
      out.error(where, `reference to origin ${key}, which isn't in origins.md`);
    }

    if (rest.length === 0 || /^(observed |version |supports:|via )/.test(rest[0])) {
      out.error(where, `reference to ${key} needs a locator after the origin`);
    } else {
      rest = rest.slice(1);
    }

    if (!rest.some((part) => part.startsWith("observed "))) {
      out.error(where, `reference to ${key} needs \`observed <date>\``);
    }
  } else {
    const found = links(parts[0]);

    if (found.length !== 1) {
      out.error(where, `reference '${parts[0]}' must start with an origin key in backticks or one link`);
    } else {
      const target = resolveLink(out, root, where, doc.path, found[0]);

      if (target === null && /^(?:[a-z]+:|#)/.test(found[0])) {
        out.error(where, "a file reference must link to a source or evidence inside the knowledge base; register external systems in origins.md");
      }

      if (target !== null) {
        cited.add(target);

        if (!["sources", "evidence"].includes(topFolder(root, target))) {
          out.error(where, `reference to ${found[0]} must be a source or evidence; link articles in the text`);
        }
      }
    }
  }

  for (const part of rest) {
    if (part.startsWith("observed ")) {
      const value = part.slice("observed ".length).trim();

      if (!date.test(value)) {
        out.error(where, `\`observed ${value}\` must be a date like 2026-10-19`);
      }
    } else if (part.startsWith("supports:")) {
      for (const name of part.slice("supports:".length).split(";").map((entry) => entry.trim())) {
        if (name !== "" && !sectionNames.has(name)) {
          out.error(where, `supports '${name}', which isn't a heading in the article`);
        }
      }
    } else if (part.startsWith("via ")) {
      const found = links(part);

      if (found.length === 0) {
        out.error(where, `\`${part}\` needs a link to the evidence`);
      } else {
        const target = resolveLink(out, root, where, doc.path, found[0]);

        if (target === null && /^(?:[a-z]+:|#)/.test(found[0])) {
          out.error(where, "`via` must link to evidence inside the knowledge base");
        }

        if (target !== null) {
          cited.add(target);

          if (topFolder(root, target) !== "evidence") {
            out.error(where, `\`via\` must link to evidence, not ${found[0]}`);
          }
        }
      }
    } else if (!part.startsWith("version ")) {
      out.error(where, `unknown part '${part}' in a reference`);
    }
  }
}

function checkBodyLinks(out, root, where, doc, from = doc.lines.length) {
  let fenced = false;

  doc.lines.slice(0, from).forEach((line) => {
    if (line.startsWith("```")) {
      fenced = !fenced;
    }

    if (!fenced) {
      for (const target of links(line)) {
        resolveLink(out, root, where, doc.path, target);
      }
    }
  });
}

// articles/<subject>.md keeps its references in references/<subject>.md.
const referencesFor = (root, article) => join(root, "references", relative(join(root, "articles"), article));

const articleFor = (root, references) => join(root, "articles", relative(join(root, "references"), references));

const linksTo = (doc, target) => doc.lines.some((line) => links(line).some((found) => resolve(dirname(doc.path), found.split("#")[0]) === target));

function checkArticle(out, root, path, origins, cited) {
  const where = rel(root, path);
  const doc = read(path);

  requireMeta(out, where, doc, "description");
  requireMeta(out, where, doc, "updated", true);

  const description = doc.meta.get("description") ?? "";

  if (description.length > 160) {
    out.warn(where, `description is ${description.length} characters; keep it to 160, since every session's context lists it`);
  }

  const all = headings(doc);

  if (!all.some((heading) => heading.level === 1)) {
    out.error(where, "needs a `#` title");
  }

  if (all.some((heading) => heading.level === 2 && heading.text === "References")) {
    out.error(where, "has a `## References` section; references live in references/<subject>.md, which `migrate` moves them to");
  }

  checkBodyLinks(out, root, where, doc);

  const referencesPath = referencesFor(root, path);
  const referencesWhere = rel(root, referencesPath);

  if (!existsSync(referencesPath)) {
    out.error(where, `needs ${referencesWhere} listing what it rests on`);

    return;
  }

  if (!linksTo(doc, referencesPath)) {
    out.warn(where, `doesn't link to ${referencesWhere}; end the article with \`Provenance: [references](${rel(dirname(path), referencesPath)})\``);
  }

  const references = read(referencesPath);
  const sectionNames = new Set(all.filter((heading) => heading.level >= 2).map((heading) => heading.text));
  const items = references.lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());

  if (items.length === 0) {
    out.error(referencesWhere, "lists nothing");
  }

  for (const item of items) {
    checkReference(out, root, referencesWhere, references, item, origins, sectionNames, cited);
  }
}

// isNew is true for evidence not yet committed, and null outside git, where old and new can't be told apart.
function checkEvidence(out, root, path, origins, isNew) {
  const where = rel(root, path);
  const doc = read(path);

  requireMeta(out, where, doc, "description");
  requireMeta(out, where, doc, "observed", true);

  const lines = section(doc, "Origins");

  if (lines === null || !lines.some((line) => line.trim() !== "")) {
    out.error(where, "needs a `## Origins` section naming what was observed");
  } else if (isNew !== false && !lines.some((line) => numbered.test(line.trim()))) {
    // Evidence committed before this rule may say in prose that it has no list; it can't be edited to add one.
    const report = isNew === null ? out.warn : out.error;

    report(where, "`## Origins` needs a numbered line per origin looked at, which a re-check reads");
  }

  for (const line of lines ?? []) {
    const match = numbered.exec(line.trim());

    if (match === null) {
      continue;
    }

    const first = splitParts(match[1])[0];
    const key = originKey(first);

    if (key !== null) {
      if (!origins.has(key)) {
        out.error(where, `origin ${key} isn't in origins.md`);
      }
    } else if (!/^<?https?:\/\//.test(first)) {
      out.error(where, `origin '${first}' must be an origin key in backticks or a URL`);
    }
  }

  checkBodyLinks(out, root, where, doc);
}

function checkSource(out, root, path) {
  const where = rel(root, path);
  const doc = read(path);

  requireMeta(out, where, doc, "kind");
  requireMeta(out, where, doc, "occurred", true);
  requireMeta(out, where, doc, "description");

  const parts = rel(join(root, "sources"), path).split("/");
  const kind = doc.meta.get("kind") ?? "";
  const folder = sourceFolders[kind];

  if (folder !== undefined && parts[0] !== folder) {
    out.error(where, `a source of kind ${kind} belongs in sources/${folder}/`);
  }

  if (parts[0] === "meetings") {
    if (parts.length !== 3) {
      out.error(where, "a meeting is a folder sources/meetings/<yyyy-mm-dd>-<subject>/ holding its transcripts and summary");
    }
  } else if (parts.length !== 2) {
    out.error(where, "a thread or page is one file directly in its kind's folder; only meetings get a folder of their own");
  }

  if (threads.has(kind) && !doc.lines.some((line) => message.test(line))) {
    out.error(where, "a thread's messages go under `## <date> [time] · <sender> (<team or role>)` headings, oldest first");
  }
}

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

  return result.error === undefined && result.status === 0 ? result.stdout : null;
}

// The evidence already committed, relative to the root, or null outside git, where all evidence counts as new.
function committedEvidence(root) {
  if (git(root, "rev-parse", "--verify", "-q", "HEAD") === null) {
    return null;
  }

  const listed = git(root, "ls-tree", "-r", "--name-only", "HEAD", "--", "evidence") ?? "";

  return new Set(listed.split("\n").filter((name) => name !== ""));
}

// In git, only threads may grow at their end; other sources and evidence never change.
function checkUnchanged(out, root) {
  if (git(root, "rev-parse", "--verify", "-q", "HEAD") === null) {
    return;
  }

  const diff = git(root, "diff", "HEAD", "--name-status", "--no-renames", "--relative", "--", "sources", "evidence");

  for (const line of (diff ?? "").split("\n").filter((entry) => entry !== "")) {
    const [status, name] = line.split("\t");

    if (status === "A") {
      continue;
    }

    if (status === "D") {
      out.error(name, "deleted; sources and evidence are kept as they were");
    } else if (name.startsWith("evidence/")) {
      out.error(name, "edited; evidence is never edited, so save a later look as new evidence");
    } else {
      const before = git(root, "show", `HEAD:./${name}`);
      const after = readFileSync(join(root, name), "utf8");

      if (before !== null && (!threads.has(read(join(root, name)).meta.get("kind")) || !after.startsWith(before))) {
        out.error(name, "edited; only a thread may grow at its end, keeping all earlier bytes");
      }
    }
  }
}

function check(root) {
  const out = report();
  const agents = join(root, "AGENTS.md");

  if (!existsSync(agents)) {
    out.error("AGENTS.md", "missing; `init` creates it");
  } else {
    const doc = read(agents);
    const version = doc.meta.get("knowledge-base-format");

    if (version === "1") {
      out.error("AGENTS.md", "says `knowledge-base-format: 1`; run `kb.mjs migrate` to move each article's references to references/");
    } else if (version !== format) {
      out.error("AGENTS.md", `front matter must say \`knowledge-base-format: ${format}\`, not '${version ?? ""}'`);
    }

    if (doc.lines.join("\n").includes("{{")) {
      out.warn("AGENTS.md", "still has `{{…}}` placeholders to fill in");
    }
  }

  const origins = loadOrigins(root, out);
  const cited = new Set();

  for (const path of markdownFiles(root)) {
    const name = rel(root, path);

    if (name.split("/").some((part) => part.startsWith("."))) continue;

    if (["articles", "references", "sources", "evidence"].includes(topFolder(root, path))) continue;

    if (["README.md", "AGENTS.md", "origins.md"].includes(name.split("/").at(-1))) continue;

    out.warn(name, "legacy article outside articles/; still discoverable, but not format-checked; migrate explicitly with approval");
  }

  for (const path of markdownFiles(join(root, "articles"))) {
    checkArticle(out, root, path, origins, cited);
  }

  for (const path of markdownFiles(join(root, "references"))) {
    if (!existsSync(articleFor(root, path))) {
      out.error(rel(root, path), `has no article at ${rel(root, articleFor(root, path))}`);
    }
  }

  const committed = committedEvidence(root);

  for (const path of markdownFiles(join(root, "evidence"))) {
    checkEvidence(out, root, path, origins, committed === null ? null : !committed.has(rel(root, path)));
  }

  for (const path of markdownFiles(join(root, "sources"))) {
    checkSource(out, root, path);
  }

  for (const path of markdownFiles(join(root, "evidence"))) {
    if (!cited.has(path)) {
      out.warn(rel(root, path), "no article cites it yet");
    }
  }

  checkUnchanged(out, root);
  checkReferencesKept(out, root);

  return out;
}

// In git, an article edited since the last commit while its references weren't may have claims nothing backs.
function checkReferencesKept(out, root) {
  if (git(root, "rev-parse", "--verify", "-q", "HEAD") === null) {
    return;
  }

  const diff = git(root, "diff", "HEAD", "--name-only", "--no-renames", "--relative", "--", "articles", "references") ?? "";
  const untracked = git(root, "ls-files", "--others", "--exclude-standard", "--", "references") ?? "";
  const changed = new Set(`${diff}\n${untracked}`.split("\n").filter((entry) => entry !== ""));

  for (const name of changed) {
    const references = rel(root, referencesFor(root, join(root, name)));

    if (name.startsWith("articles/") && existsSync(join(root, name)) && !changed.has(references)) {
      out.warn(name, `changed while ${references} didn't; if its claims changed, update what they rest on`);
    }
  }
}

function init(root, name) {
  if (existsSync(join(root, "AGENTS.md"))) {
    console.error(`${join(root, "AGENTS.md")} already exists; nothing changed`);

    return 1;
  }

  if (existsSync(root) && readdirSync(root).length > 0) {
    console.error(`${root} is not empty; use the skill's explicit free-form migration guidance; nothing changed`);

    return 1;
  }

  for (const folder of ["articles", "references", "sources", "evidence"]) {
    mkdirSync(join(root, folder), { recursive: true });
  }

  const template = readFileSync(join(skillDir, "assets", "AGENTS.md"), "utf8");

  writeFileSync(join(root, "AGENTS.md"), name === undefined ? template : template.replaceAll("{{name}}", name));

  if (!existsSync(join(root, "origins.md"))) {
    writeFileSync(join(root, "origins.md"), "# Origins\n\nThe systems this knowledge base's claims come from, and how to reach each.\n");
  }

  console.log(`started a knowledge base at ${root}; fill in the placeholders in AGENTS.md`);

  return 0;
}

function stale(root, article, olderThan) {
  const origins = loadOrigins(root, report());
  const paths = article === undefined ? markdownFiles(join(root, "articles")) : [join(root, article)];
  const today = new Date(new Date().toISOString().slice(0, 10));
  const rows = [];

  for (const path of paths) {
    if (!existsSync(path)) {
      console.error(`${path} doesn't exist`);

      return 1;
    }

    const references = referencesFor(root, path);

    for (const line of existsSync(references) ? read(references).lines : []) {
      if (!line.startsWith("- ")) {
        continue;
      }

      const parts = splitParts(line.slice(2).trim());
      const key = originKey(parts[0]);
      const observed = parts.find((part) => part.startsWith("observed "))?.slice("observed ".length) ?? "";

      if (key === null || !date.test(observed)) {
        continue;
      }

      const age = (today.getTime() - new Date(observed).getTime()) / 86_400_000;

      if (olderThan === undefined || age >= olderThan) {
        rows.push({ observed, where: rel(root, path), key, locator: parts[1] ?? "" });
      }
    }
  }

  rows.sort((left, right) => left.observed.localeCompare(right.observed) || left.where.localeCompare(right.where));

  for (const row of rows) {
    console.log(`${row.observed}  ${row.where}  ${row.key} · ${row.locator}`);

    for (const line of origins.get(row.key) ?? []) {
      console.log(`    ${line}`);
    }
  }

  if (rows.length === 0) {
    console.log("no origin references to re-check");
  }

  return 0;
}

// A reference line as format 2 writes it: a commit version shortened to 12 characters, and `supports:` left out
// when it names every section, since a reference without one backs the whole article.
function shortened(item, sectionNames) {
  return splitParts(item)
    .map((part) => (/^version [0-9a-f]{40}$/.test(part) ? part.slice(0, "version ".length + 12) : part))
    .filter((part) => {
      if (!part.startsWith("supports:")) {
        return true;
      }

      const named = new Set(part.slice("supports:".length).split(";").map((name) => name.trim()));

      return sectionNames.size === 0 || [...sectionNames].some((name) => !named.has(name));
    })
    .join(" · ");
}

// Moves each article's References section to references/<subject>.md and links it from the article's end.
function migrate(root) {
  const agents = join(root, "AGENTS.md");
  const version = existsSync(agents) ? read(agents).meta.get("knowledge-base-format") : undefined;

  if (version === format) {
    console.log(`already knowledge-base-format ${format}; nothing changed`);

    return 0;
  }

  if (version !== "1") {
    console.error(`migrate converts knowledge-base-format 1, but AGENTS.md says '${version ?? ""}'`);

    return 1;
  }

  // Refuse before writing any article, so a conflicting references file is never overwritten.
  for (const path of markdownFiles(join(root, "articles"))) {
    if (section(read(path), "References") !== null && existsSync(referencesFor(root, path))) {
      console.error(`${referencesFor(root, path)} already exists; reconcile it before migrating; nothing changed`);

      return 1;
    }
  }

  let before = 0;
  let after = 0;

  for (const path of markdownFiles(join(root, "articles"))) {
    const raw = readFileSync(path, "utf8").split(/\r?\n/);
    const doc = read(path);
    const offset = raw.length - doc.lines.length;
    const all = headings(doc);
    const heading = all.find((entry) => entry.level === 2 && entry.text === "References");

    if (heading === undefined) {
      console.log(`skipped   ${rel(root, path)}: no References section`);
      continue;
    }

    const next = all.find((entry) => entry.index > heading.index && entry.level <= 2);
    const end = offset + (next === undefined ? doc.lines.length : next.index);
    const sectionNames = new Set(all.filter((entry) => entry.level >= 2 && entry.text !== "References").map((entry) => entry.text));
    const items = raw.slice(offset + heading.index + 1, end).map((line) => (line.startsWith("- ") ? `- ${shortened(line.slice(2).trim(), sectionNames)}` : line));
    const title = all.find((entry) => entry.level === 1)?.text ?? rel(join(root, "articles"), path);
    const references = referencesFor(root, path);
    const kept = [...raw.slice(0, offset + heading.index), ...raw.slice(end)].join("\n").trimEnd();
    const article = `${kept}\n\nProvenance: [references](${rel(dirname(path), references)})\n`;
    const listing = `# References · ${title}\n\n${items.join("\n").trim()}\n`;

    mkdirSync(dirname(references), { recursive: true });
    writeFileSync(references, listing);
    writeFileSync(path, article);
    before += raw.join("\n").length;
    after += article.length;
    console.log(`moved     ${rel(root, path)} → ${rel(root, references)}`);
  }

  writeFileSync(agents, readFileSync(agents, "utf8").replace(/^knowledge-base-format:\s*1\s*$/m, `knowledge-base-format: ${format}`));
  console.log(`articles: ${before} → ${after} bytes`);
  console.log(`AGENTS.md now says format ${format}; bring its lookup steps and rules in line with this skill's assets/AGENTS.md`);

  return 0;
}

function main() {
  const usage = "usage: kb.mjs init <folder> [--name NAME] | check <folder> | stale <folder> [--article PATH] [--older-than DAYS] | migrate <folder>";

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { name: { type: "string" }, article: { type: "string" }, "older-than": { type: "string" }, help: { type: "boolean", short: "h" } }
  });

  const [command, folder] = positionals;

  if (values.help === true || folder === undefined || !["init", "check", "stale", "migrate"].includes(command)) {
    console.error(usage);

    return values.help === true ? 0 : 2;
  }

  const root = resolve(folder.startsWith("~") ? join(homedir(), folder.slice(1)) : folder);

  if (command === "init") {
    return init(root, values.name);
  }

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`${root} isn't a folder`);

    return 1;
  }

  if (command === "stale") {
    const days = values["older-than"];

    return stale(root, values.article, days === undefined ? undefined : Number(days));
  }

  if (command === "migrate") {
    return migrate(root);
  }

  const out = check(root);

  for (const line of out.errors) {
    console.log(`error: ${line}`);
  }

  for (const line of out.warnings) {
    console.log(`warning: ${line}`);
  }

  console.log(`${out.errors.length} error(s), ${out.warnings.length} warning(s)`);

  return out.errors.length > 0 ? 1 : 0;
}

process.exitCode = main();
