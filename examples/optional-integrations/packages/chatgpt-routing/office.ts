import { Package } from "@office/sdk";
import { directConnectors } from "./routes.ts";

export default Package.define({
  settings: {
    type: "object",
    additionalProperties: false,
    properties: {
      routes: {
        type: "object",
        default: {},
        additionalProperties: false,
        properties: {
          gmail: { enum: ["off", "direct", "executor", "both"], default: "direct" },
          calendar: { enum: ["off", "direct"], default: "direct" },
        },
      },
      executor: {
        type: "object",
        default: {},
        additionalProperties: false,
        properties: {
          app: { type: "boolean", default: false, description: "Register the chatgpt app with mock-executor, with or without tools" },
          name: { type: "string", default: "chatgpt" },
        },
      },
    },
    // Gmail through Executor needs the app: there is no fallback to the direct route.
    if: { properties: { routes: { properties: { gmail: { enum: ["executor", "both"] } }, required: ["gmail"] } }, required: ["routes"] },
    then: { properties: { executor: { properties: { app: { const: true } }, required: ["app"] } }, required: ["executor"] },
  },
  // The app is an explicit request: without its provider, fail rather than fall back to the direct route.
  setup(ctx) {
    if (ctx.settings.executor.app && !ctx.providers.selected("mock-executor")) throw new Error("executor.app needs package mock-executor, which office.yaml doesn't select; add mock-executor to office.yaml, or set executor.app to false");
  },
  commands: {
    "chatgpt-routing direct": { summary: "List the connectors routed directly to the agent, as JSON", result: ({ settings }) => JSON.stringify(directConnectors(settings.routes)) },
  },
});
