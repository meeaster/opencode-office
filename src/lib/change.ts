import * as v from "valibot";

const failureSchema = v.object({ failure: v.string() });
export const changeSchema = v.union([v.string(), failureSchema]);

export type Change = v.InferOutput<typeof changeSchema>;

export function failure(text: string) {
  return { failure: text };
}

export function isFailure(change: Change): change is { failure: string } {
  return v.is(failureSchema, change);
}

export function changeText(change: Change) {
  return isFailure(change) ? change.failure : change;
}
