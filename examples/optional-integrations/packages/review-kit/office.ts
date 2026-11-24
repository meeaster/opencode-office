import { Package } from "@office/sdk";

export default Package.define({
  settings: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", default: "Review checklist" },
      // No default: left out, the author's default decides; false turns the offer off.
      skills: { type: "boolean", description: "Offer the review-checklist skill to the skills package" },
    },
  },
  integrations: {
    "@office/skills": { enabledByDefault: true, requested: settings => settings.skills },
  },
  commands: {
    "review-kit show": { summary: "Print the checklist title", result: ({ settings }) => settings.title },
  },
});
