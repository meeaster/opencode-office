export default {
  name: "artifact-share",
  description: "Shares what the user asks to share as pages in the office's artifacts/ folder, published to a GitHub Pages site with an index.",
  settings: {
    url: {
      description: "The Pages site's base address, such as https://<owner>.github.io/<repository>, where each artifact is <url>/<artifact>/",
      required: true,
    },
    title: {
      description: "The site's name, shown as the index page's heading and on each rendered page's link back to it",
      default: "Artifacts",
    },
    theme: {
      description: "The theme a reader sees until they choose another with the site's picker, by id, such as paper, dracula or github; see the package README for the list",
      default: "paper",
    },
  },
};
