import type { PackageContext } from "@office/office/context";
import { repositories } from "@office/references/repositories";
import { requirements } from "@office/tooling/requirements";

export default {
  name: "aws-emulator",
  namespace: "floci",
  description: "A local AWS emulator, Floci (https://github.com/floci-io/floci), with its web console, in the office's compose project, for testing against AWS APIs without a real account; agents use it through the AWS CLI the package installs and the floci skill.",
  spawns: { label: "floci_namespace=office-${OFFICE_NAME}-floci" },
  setup(ctx: PackageContext) {
    ctx.add(requirements, { name: "aws-cli", minimumVersion: "2.40.4" });
    ctx.scalarSetting("port", { description: "The loopback port the AWS endpoint is published on, and Floci listens on inside its container, so http://localhost.floci.io:<port> answers on the host and the compose network alike", default: 4566 });
    ctx.scalarSetting("ui_port", { description: "The loopback port Floci's web console is published on, which the browser opens as http://floci.localhost:<ui_port>", default: 4500 });
    ctx.scalarSetting("storage", { description: "Floci's storage mode, memory, persistent, hybrid or wal; anything but memory keeps state across restarts in the floci-data volume", default: "memory" });
    const includeSource = ctx.booleanSetting("source_reference", { description: "Include the Floci source checkout in references/", default: true });

    if (!includeSource) return;

    ctx.add(repositories, {
      name: "floci", url: "https://github.com/floci-io/floci.git", ref: "main",
      description: "Floci's source and docs for the local AWS emulator (docs in docs/).",
    });
  },
};
