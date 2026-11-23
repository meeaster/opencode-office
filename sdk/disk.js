// The runtime entry of the @office/sdk copy sync writes beside an office's packages. That copy is
// there for editors and tsc; a package loaded by office gets the executable's own SDK instead.
throw new Error("@office/sdk was loaded from disk; the executable's SDK was not registered");
