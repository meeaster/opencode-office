---
name: browser-automation
description: Choose and use a browser tool. Use before verifying a UI change, automating or reading a web page, or doing something in the user's own Chrome, such as a site they are signed in to.
---

# Browser automation

The office's mode (`opencode:` in `office.yaml`) decides which browsers exist. In **host mode** OpenCode runs on the machine itself and has what it has, the user's own Chrome through Browse included. In **container mode** OpenCode runs in a container with no desktop: browser work goes through `agent-browser`, and the in-app browser when the desktop app is attached. Browse is never available in a container-mode office, even to a host session opened in it.

Pick by whose browser the task needs:

| Tool | Drives | Use for |
|---|---|---|
| `agent-browser` | A headless Chromium of its own, on the machine OpenCode runs on; both modes | Verifying UI work, repeatable checks, scraping public pages, anything unattended |
| `browse` | Host mode only: the user's real Chrome, with their logins, cookies and extensions, through the Browse extension | Sites the user is signed in to, tasks in their session, handing control to the user (a login, a CAPTCHA, a confirmation) |
| `tools.browser.*` | OpenCode's in-app browser, beside the session in the desktop app | Showing the user a page while you work on it, when those tools are present: only when the desktop app is attached to this session. OpenCode's own `browser` skill covers them |

Default to `agent-browser`. Reach for `browse` only when the task needs the user's own browser state, and say so before acting there: the user's tabs, cookies and logins are shared, so its actions are real and visible to them.

## MCP tools or the CLI

- Each tool's MCP server, when registered, gives typed tools and its own instructions; follow them over anything remembered, as both change often. "This session's servers" below says which are registered.
- agent-browser's guide: `agent-browser skills get core` (`--full` for every command). The CLI takes the same commands as the MCP tools, so a check you will rerun goes in a script of `agent-browser --session <name> ...` lines.
- Browse's guide: `~/.local/bin/browse --help`. Call it by that full path: `/usr/bin/browse` is xdg-utils, unrelated.
- With Code Mode's `execute`, run a whole check as one script of MCP calls and return only pass or fail with short details.

## Verifying a UI change

1. Serve the page over HTTP on `127.0.0.1` (reuse a running dev server); open `http://127.0.0.1:<port>/...`, never `file://`.
2. Use your own `session` name, and take a fresh snapshot after each navigation before using its refs.
3. Act through the rendered controls as a user would, and after each step assert what the page shows; a screenshot when layout matters.
4. Report what you saw, with the screenshot's path, and close the session.

The change is verified when every step's assertion held in the rendered page; a passing build or unit test is not that.
