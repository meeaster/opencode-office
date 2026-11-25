import { Package } from "@office/sdk";

export default Package.define({
  settings: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", default: "Review checklist" },
      // No default: left out, the skill is offered exactly when the office selects skills; false turns the offer off.
      skills: { type: "boolean", description: "Offer the review-checklist skill to the skills package" },
    },
  },
  // true is an explicit request: without skills selected, fail rather than leave the offer out.
  setup(ctx) {
    if (ctx.settings.skills === true && !ctx.providers.selected("skills")) throw new Error("skills: true needs package skills, which office.yaml doesn't select; add skills to office.yaml, or leave skills out to offer the skill whenever it is selected");
  },
  commands: {
    "review-kit show": { summary: "Print the checklist title", result: ({ settings }) => settings.title },
  },
});
