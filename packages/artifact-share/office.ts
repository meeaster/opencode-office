import { Package } from "@office/sdk";

export default Package.define({
  settings: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", description: "The Pages site's base address, such as https://<owner>.github.io/<repository>, where each artifact is <url>/<artifact>/" },
      title: { type: "string", default: "Artifacts", description: "The site's name, shown as the index page's heading and on each rendered page's link back to it" },
      theme: { type: "string", default: "paper", description: "The theme a reader sees until they choose another with the site's picker, by id, such as paper, dracula or github; see the package README for the list" },
    },
  },
});
