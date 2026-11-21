# Vision

What `office` is for and where it is going. It changes only when the project's owner says so. When a proposal conflicts with it, say so before going further.

## What an office is

An office is a source-controlled folder for any kind of work: software projects, notes, operations. The `office` CLI sets it up, keeps it in sync and checks it. AI agents are one thing an office can have, not a requirement: an office without an agent runtime is a complete office.

## Goals

1. **Everything is a package.** The CLI is a small kernel: it finds the office, gets package sources, loads the selected packages and dispatches their commands. Every capability above that (tools, references, scheduled jobs, services, secrets, agent runtimes) is a package. The kernel refers to no package by name.
2. **One API for everyone.** First-party packages use only the public package API, so a package anyone writes runs on the same code paths as the built-ins, and every built-in hardens the API others rely on. The test: replacing a built-in package with your own needs no change to the kernel.
3. **Packages come from anywhere.** Built into the executable, from a Git repository at a pinned ref, or written in the office itself. The owner selects and configures them in `office.yaml`.
4. **Packages build on each other.** A package can offer something other packages contribute to or call, and declares the packages it depends on.
5. **The office stays the owner's project.** Native tools keep their native configuration: mise TOML, Compose YAML, an agent runtime's own config. The office works around those files rather than replacing them, it is always clear which files are the owner's, and the office's own plumbing stays out of Git.
6. **Agent runtimes are integrations.** OpenCode and Claude Code are packages an office may select, alone or together. A package states once what it gives an agent (skills, MCP servers, context, commands), and each runtime package delivers that in its own format. A package can still ship a part for one runtime when something doesn't translate.
7. **Standard mechanisms over custom ones.** Prefer what tools already understand, such as `package.json`, ordinary module resolution and each tool's native files, to formats and resolvers of our own. Borrow proven designs, such as OpenCode's plugin model, without depending on them.

## Long term

- **Presets:** starting points for different kinds of office, such as an AI development office or a plain notes office, each a package that depends on the packages it needs.
- **Shared packages:** other people writing, publishing and using office packages.

## Where the code stands

The vision is ahead of the code. Today OpenCode is built into the core, and several capabilities are compiled into the CLI rather than delivered as packages. The code moves toward the vision in steps.
