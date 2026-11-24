// What office setup reads before cloning anything: each mirror with a URL, read-write when the
// office pushes to it. Settings here are office.yaml's as written, not yet checked, so each field is
// read only when it has the expected type.
import { Package } from "@office/sdk";

export default Package.access((settings) => {
  const mirrors = Array.isArray(settings.mirrors) ? settings.mirrors : [];

  return mirrors.flatMap((mirror) => {
    if (typeof mirror !== "object" || mirror === null || Array.isArray(mirror)) return [];
    const { name, url, push } = mirror;

    if (typeof name !== "string" || typeof url !== "string") return [];

    return [{ name, url, access: push === true ? "read-write" : "read" }];
  });
});
