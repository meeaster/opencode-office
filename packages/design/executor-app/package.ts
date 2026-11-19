// The design package's settings as office.yaml resolves them. `office apps deploy` sends a copy
// generated from the office's own settings in place of this file, which holds the package's
// defaults with the same shape, for type-checking.
export const settings = {
  port: 41441,
  url: "",
  executor_app: false,
  oauth: true,
};

/** Where the office's OpenCode server runs: "host" or "container". */
export const opencode = "container";
