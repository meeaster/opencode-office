// Where this app reaches the office's OpenCode server, and the office's folder as that server sees
// it. `office apps deploy` replaces this file with the values for the mode office.yaml's
// `opencode:` sets; this copy holds container mode's, the default. Don't edit it by hand.
export const origin = "http://opencode:4096";

/** The provider's credential host: Executor sends the password only to this host and port. */
export const host = "opencode:4096";

/** Session folders are under this one. */
export const officeDirectory = "/home/assistant/workspace";
