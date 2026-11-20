import type { PackageContext } from "../office/package-context.ts";

const chrome = "/usr/bin/google-chrome-stable";

export default {
  name: "browser",
  description: "Browser automation for agents. agent-browser drives a headless Chromium of its own, in either mode, or, opted into on an Ubuntu WSL host, Google Chrome from apt; in a host-mode office, Browse also drives the user's own Chrome, with their logins. Each is an MCP server in every session where it applies.",
  settings: {
    agent_browser_tools: {
      description: "The tool profiles the agent-browser MCP server starts with (`agent-browser mcp --tools`), comma-separated, such as core, core,network or all; empty for no agent-browser server",
      default: "core"
    },
    browse: {
      description: "Whether a host-mode office gets Browse, the user's own Chrome, installed and as the browse MCP server; container-mode offices never do",
      default: true
    },
    system_chrome: {
      description: "Whether a host-mode office on Ubuntu 24.04 or 26.04 amd64 under WSL has agent-browser launch Google Chrome Stable from Google's apt repository, /usr/bin/google-chrome-stable (the Chrome WSLg runs, with a temporary profile of its own each launch), which `office setup` offers to install once (mise asks for sudo) and unattended-upgrades keeps patched. Independent of browse; never in a container-mode office",
      default: false
    }
  },
  async setup(ctx: PackageContext) {
    const { requirements } = await ctx.importStandard("tooling/requirements");
    const { installs, recipes } = await ctx.importStandard("mise-integration/claims");
    ctx.add(requirements, { name: "npm:agent-browser", minimumVersion: "0.43.0" });

    if (String(ctx.settings.browse) === "true") {
      ctx.add(requirements, { name: "bun", minimumVersion: "1.4.4", hostOnly: true });
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
};
