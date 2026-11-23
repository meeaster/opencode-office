import { Package } from "@office/sdk";
import { requirements } from "./requirements.ts";

export default Package.define({
  setup(ctx) {
    ctx.registry(requirements);
  },
});
