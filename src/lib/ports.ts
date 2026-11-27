export function ports() {
  return {
    executor: process.env.EXECUTOR_PORT ?? "41440",
    opencode: process.env.OPENCODE_PORT ?? "41497",
  };
}
