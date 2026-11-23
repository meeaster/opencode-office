import { Package } from "@office/sdk";
import { repositories } from "@office/references/repositories";
import { requirements } from "@office/tooling/requirements";

export default Package.define({
  namespace: "floci",
  spawns: { label: "floci_namespace=office-${OFFICE_NAME}-floci" },
  settings: {
    type: "object",
    additionalProperties: false,
    properties: {
      port: { type: "integer", default: 4566, description: "The loopback port the AWS endpoint is published on, and Floci listens on inside its container, so http://localhost.floci.io:<port> answers on the host and the compose network alike" },
      ui_port: { type: "integer", default: 4500, description: "The loopback port Floci's web console is published on, which the browser opens as http://floci.localhost:<ui_port>" },
      storage: { enum: ["memory", "persistent", "hybrid", "wal"], default: "memory", description: "Floci's storage mode, memory, persistent, hybrid or wal; anything but memory keeps state across restarts in the floci-data volume" },
      source_reference: { type: "boolean", default: true, description: "Include the Floci source checkout in references/" },
    },
  },
  setup(ctx) {
    ctx.add(requirements, { name: "aws-cli", minimumVersion: "2.40.4" });

    if (!ctx.settings.source_reference) return;

    ctx.add(repositories, {
      name: "floci", url: "https://github.com/floci-io/floci.git", ref: "main",
      description: "Floci's source and docs for the local AWS emulator (docs in docs/).",
    });
  },
});
