// Socket Firewall (sfw, https://github.com/SocketDev/sfw-free): every package download an office
// makes goes through it. sfw runs a command behind a local proxy that refuses packages Socket knows
// to be malicious, so the office puts a folder of wrappers first on PATH, one per package manager,
// each running `sfw <tool>`, and routes mise's installs through it too. Package managers also wait
// the minimum release age below before they take a new release.
//
// This module is the one list of what is wrapped and of the variables, for the container's image
// and entrypoint and for a host-mode office's machine.

/** How old a package release must be before a package manager takes it, and before upgrade-tools moves sfw. */
export const packageAge = "3d";

/** The package managers whose commands go through sfw, by the names their wrappers have on PATH. */
export const wrappedCommands = ["npm", "npx", "pnpm", "pip", "pip3", "uv", "uvx", "cargo"] as const;

/**
 * The variables that make package managers wait `packageAge` before they take a release: npm in
 * days, pnpm in minutes, uv as a duration it reads relative to now, pip as an ISO 8601 duration.
 */
export const releaseAgeVariables = {
  NPM_CONFIG_MIN_RELEASE_AGE: "3",
  pnpm_config_minimum_release_age: "4320",
  UV_EXCLUDE_NEWER: "3 days",
  PIP_UPLOADED_PRIOR_TO: "P3D",
} satisfies Record<string, string>;
