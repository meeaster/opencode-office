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
          gmail: { enum: ["off", "direct", "executor"], default: "direct" },
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
    if: { properties: { routes: { properties: { gmail: { const: "executor" } }, required: ["gmail"] } }, required: ["routes"] },
    then: { properties: { executor: { properties: { app: { const: true } }, required: ["app"] } }, required: ["executor"] },
  },
  integrations: {
    "@office/mock-executor": { requested: settings => settings.executor.app },
  },
  commands: {
    "chatgpt-routing direct": { summary: "List the connectors routed directly to the agent, as JSON", result: ({ settings }) => JSON.stringify(directConnectors(settings.routes)) },
  },
});
