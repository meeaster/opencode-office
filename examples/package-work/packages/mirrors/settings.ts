// The mirrors package's settings, shared by its definition and its access declaration, which
// imports nothing else so it can run before the office has a package set.
export const settingsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mirrors: {
      type: "array",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description"],
        properties: {
          name: { type: "string", minLength: 1, description: "What sessions and sync call it" },
          description: { type: "string", minLength: 1, description: "What it holds, for sessions" },
          url: { type: "string", minLength: 1, description: "Its repository; without one it is listed only" },
          push: { type: "boolean", default: false, description: "Whether the office pushes to it" },
        },
      },
    },
  },
} as const;
