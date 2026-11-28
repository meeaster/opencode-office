import * as v from "valibot";

/**
 * A published port, read as whether it binds only 127.0.0.1: the short syntax binds every
 * interface unless it starts with a host address (`127.0.0.1:8080:80`), the long syntax unless its
 * `host_ip` is one.
 */
const composePort = v.union(
  [
    v.pipe(
      v.string(),
      v.transform((port) => ({ loopback: port.startsWith("127.0.0.1:") })),
    ),
    v.pipe(
      v.number(),
      v.transform(() => ({ loopback: false })),
    ),
    v.pipe(
      v.looseObject({ host_ip: v.optional(v.string()) }),
      v.transform((port) => ({ loopback: port.host_ip === "127.0.0.1" })),
    ),
  ],
  "must be a port",
);

/** The parts of a Compose file office checks in a package's compose.yaml; anything else passes through to Compose. */
export const composeFileSchema = v.looseObject(
  {
    services: v.nullish(v.record(v.string(), v.looseObject({ ports: v.optional(v.array(composePort)), network_mode: v.optional(v.string()) }, "must be a service")), {}),
    volumes: v.nullish(v.record(v.string(), v.nullable(v.looseObject({ name: v.optional(v.string()), external: v.optional(v.boolean()) }, "must be a volume"))), {}),
    networks: v.nullish(v.record(v.string(), v.nullable(v.looseObject({}))), {}),
    configs: v.nullish(v.record(v.string(), v.nullable(v.looseObject({}))), {}),
    secrets: v.nullish(v.record(v.string(), v.nullable(v.looseObject({}))), {}),
  },
  "must be a Compose file",
);

export type ComposeFile = v.InferOutput<typeof composeFileSchema>;
