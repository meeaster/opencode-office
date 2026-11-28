import { opencode } from "@office/opencode";
import { Package } from "@office/sdk";
import { installs, recipes } from "@office/mise-integration/claims";
import { tools } from "@office/tools";
import { agentBrowser } from "./tool.ts";

const chrome = "/usr/bin/google-chrome-stable";

export default Package.define({
  settings: {
    type: "object",
    additionalProperties: false,
    properties: {
      agent_browser_tools: { type: "string", default: "core", description: "The tool profiles the agent-browser MCP server starts with (`agent-browser mcp --tools`), comma-separated, such as core, core,network or all; empty for no agent-browser server" },
      browse: { type: "boolean", default: true, description: "Whether a host-mode office gets Browse, the user's own Chrome, installed and as the browse MCP server; container-mode offices never do" },
      system_chrome: { type: "boolean", default: false, description: "Whether a host-mode office on Ubuntu 24.04 or 26.04 amd64 under WSL has agent-browser launch Google Chrome Stable from Google's apt repository, /usr/bin/google-chrome-stable (the Chrome WSLg runs, with a temporary profile of its own each launch), which `office setup` offers to install once (mise asks for sudo) and unattended-upgrades keeps patched. Independent of browse; never in a container-mode office" },
    },
  },
  setup(ctx) {
    opencode.plugins.add(ctx, { directory: "plugin" });
    tools.require(ctx, agentBrowser);

    if (ctx.settings.browse) {
      tools.require(ctx, { name: "bun", minimum: "1.4.4", bin: "bun", hostOnly: true });
      ctx.add(installs, { name: "install", destination: "~/.local/bin/browse", ready: "~/.local/bin/browse", executable: true, script: "scripts/install-browse.ts", description: "Browse" });
    }

    ctx.add(recipes, {
      name: "chrome",
      setting: "system_chrome",
      description: "Google Chrome Stable from Google's apt repository, for agent-browser",
      platforms: ["ubuntu-24.04-amd64-wsl", "ubuntu-26.04-amd64-wsl"],
      prepare: "scripts/google-chrome-apt-source.sh",
      verify: "scripts/verify-system-chrome.sh",
      bootstrap: "system/google-chrome.toml",
      ready: [
        chrome,
        "/etc/apt/sources.list.d/google-chrome.sources",
        "/usr/bin/certutil",
        "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/bin/unattended-upgrade",
      ],
      env: { AGENT_BROWSER_EXECUTABLE_PATH: chrome },
    });
  },
});
