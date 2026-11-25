import { Package } from "@office/sdk";
import { userUnits } from "./handles.ts";

export default Package.define({
  setup(ctx) {
    ctx.registry(userUnits);
  },
});
