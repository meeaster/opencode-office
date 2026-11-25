import type { ExecutorAccess } from "@office/sdk";

/**
 * Waits for Executor while it starts, as after `office up` replaced its container: an unreachable
 * Executor, a slow answer or a server error is tried again, up to `attempts` times `pause` ms
 * apart; any other answer, such as a refused token, fails at once.
 */
export async function ready(executor: ExecutorAccess, { attempts = 60, pause = 2_000 } = {}): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await executor.request("GET", "/api/context", undefined, { timeout: 5_000 });

      return;
    } catch (error) {
      const answered = error instanceof Error && "status" in error && typeof error.status === "number" && error.status < 500;

      if (attempt >= attempts || answered) throw error;
    }

    await Bun.sleep(pause);
  }
}
