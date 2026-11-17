---
name: doop
description: Design on the office's own Doop canvas through the doop MCP server. Use when the user asks to design, mock up, wireframe or prototype screens or a site, or mentions Doop, a canvas, a frame or a design comment.
---

# Doop

This office runs its own [Doop](https://github.com/kgoedecke/doop), a design canvas that humans and agents edit together live. Sessions reach it as the `doop` MCP server, acting as the person whose agent key connects the office: their canvases, their access, edits shown under the `agent_name` you choose.

## Using it

- Call `get_guide({ topic: "doop-instructions" })` before any other `doop` tool, and again if the conversation may have lost it. The server's own instructions and that guide say how to work on a canvas; follow them rather than anything remembered from elsewhere.
- When you give the user a link to a canvas or frame, use the address in "This office's Doop" below: it is the one their browser opens. Links the tools return already use it.
- Doop's own agent, image generation and model features need a model key the user connects in Doop's settings. Your edits over MCP don't.

## When there are no `doop` tools

The office isn't connected yet, or its key no longer works. Tell the user to do this once; the tools arrive within seconds of saving the key:

1. Open Doop at the address below and sign up, or sign in if they already have an account.
2. Under **Settings → Agent keys**, create a key named after the office.
3. Save it in the office, from its root, without pasting it anywhere else:

   ```sh
   (umask 077; read -rs key && printf '%s\n' "$key" > .opencode/doop/agent-key)
   ```

   `.opencode/doop/` ignores everything in it but its `.gitignore`, so the key is never committed.

Never ask the user to paste the key into the conversation.
