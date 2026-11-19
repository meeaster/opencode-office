---
name: doop
description: Design on the office's own Doop canvas through the doop MCP server. Use when the user asks to design, mock up, wireframe or prototype screens or a site, or mentions Doop, a canvas, a frame or a design comment.
---

# Doop

This office runs its own [Doop](https://github.com/kgoedecke/doop), a design canvas that humans and agents edit together live. Sessions reach it with Doop's own MCP tools, acting as the person whose Doop account connects the office: their canvases, their access, edits shown under the `agent_name` you choose. "This office's Doop" below says which way this office connects.

## Using it

- Call `get_guide({ topic: "doop-instructions" })` before any other Doop tool, and again if the conversation may have lost it. The server's own instructions and that guide say how to work on a canvas; follow them rather than anything remembered from elsewhere.
- When you give the user a link to a canvas or frame, use the address in "This office's Doop" below: it is the one their browser opens. Links the tools return already use it.
- Doop's own agent, image generation and model features need a model key the user connects in Doop's settings. Your edits over MCP don't.

## With the agent key file

The tools are the `doop` MCP server's. When there are none, the office isn't connected yet, or its key no longer works. Tell the user to do this once; the tools arrive within seconds of saving the key:

1. Open Doop at the address below and sign up, or sign in if they already have an account.
2. Under **Settings → Agent keys**, create a key named after the office.
3. Save it in the office, from its root, without pasting it anywhere else:

   ```sh
   (umask 077; read -rs key && printf '%s\n' "$key" > .opencode/doop/agent-key)
   ```

   `.opencode/doop/` ignores everything in it but its `.gitignore`, so the key is never committed.

## Through Executor

The tools are the `doop` Executor app's: find them with office-executor's `search` (namespace `doop`) and call them through `call` or `execute`, with the same names and inputs as Doop's MCP tools. Tools that delete or overwrite work ask the user for approval first; show them the approval link.

The app uses one Doop account for the whole office. Without it the app exposes no tools. Then request a connection link for the app's `doop` requirement, as the Executor app's `code-mode` skill describes for an app's own account, and give the user the link with these steps. `office apps deploy` also prints a link while the account is missing.

1. Open Doop at the address below in the browser they'll use for the link, and sign in (or sign up). Do this first: Doop's sign-in page doesn't return to a sign-in that Executor started.
2. Open the link, signed in to Executor, and choose a sign-in method:
   - **Sign in with Doop**, offered unless the office turned it off: Doop authorizes at once and Executor saves the account.
   - **Agent key**: create one in Doop under **Settings → Agent keys** and enter it in Executor's form.
3. If they started signed out and Doop left them on its sign-in page or canvases after signing in, they open the same link again and choose **Sign in with Doop** again; a new link from you works too.

Never ask the user to paste a key into the conversation.
