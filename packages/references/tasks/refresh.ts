type Progress = { line?: (text: string) => void; verbose?: boolean };

type Verify = () => undefined;

/** Native operations bound to one checkout, run while the caller holds its lease. */
export type ReferenceGit = {
  targetProblem(present: boolean): string | undefined;
  stageClone(progress: Progress, verify: Verify): Promise<"cloned">;
  fetchExisting(progress: Progress, verify: Verify): Promise<"updated" | "current">;
};

/** Linked into composed sync: clones a missing checkout or updates a present one, checking its target before and after the fetch. */
export function prepareReferenceRefresh(present: boolean, git: ReferenceGit) {
  function verify(): undefined {
    const problem = git.targetProblem(present);

    if (problem) throw new Error(problem);
  }

  return (progress: Progress) => {
    verify();

    return present ? git.fetchExisting(progress, verify) : git.stageClone(progress, verify);
  };
}
