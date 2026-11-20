type Progress = { line?: (text: string) => void; verbose?: boolean };

type Verify = () => undefined;

/** Native operations bound to one planned checkout and its current-claim guard. */
export type ReferenceGit = {
  targetProblem(present: boolean): string | undefined;
  appliedProblem(): string | undefined;
  checkBeforeFetch(verify: Verify): void;
  stageClone(progress: Progress, verify: Verify): Promise<"cloned">;
  fetchExisting(progress: Progress, verify: Verify): Promise<"updated" | "current">;
};

/** Linked into composed sync. Preparation classifies refusals before the host queues any Git work. */
export function prepareReferenceRefresh(present: boolean, stale: boolean, git: ReferenceGit) {
  if (stale && !present) throw new Error("stale contribution cannot authorize a new clone; repair the contributor and run office sync --packages");

  function verify(): undefined {
    const problem = git.targetProblem(present) ?? (stale ? git.appliedProblem() : undefined);

    if (problem) throw new Error(problem);
  }

  return (progress: Progress) => {
    git.checkBeforeFetch(verify);

    return present ? git.fetchExisting(progress, verify) : git.stageClone(progress, verify);
  };
}
