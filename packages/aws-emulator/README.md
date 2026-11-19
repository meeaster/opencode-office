# aws-emulator

An `office` package: the office runs [Floci](https://github.com/floci-io/floci), an open-source local emulator of the AWS APIs, with its web console, so people and agents can test against S3, SQS, DynamoDB, Lambda, EC2 and the rest without a real account. Agents use it through the AWS CLI, which the package installs, and SDKs, as its `floci` skill teaches.

## Install

It is built into `office`. In `office.yaml`:

```yaml
packages:
  - name: aws-emulator
```

Then run `office sync` and commit what it wrote: the package in `.office/packages/aws-emulator/`, which updates with `office` and is read-only there, and `aws-cli` in `machine.packages.toml`. Run `office up`, which starts Floci and its console.

| Setting | |
|---|---|
| `port` | The loopback port the AWS endpoint is published on; `4566` by default. Floci listens on the same port inside its container. The endpoint is `http://localhost.floci.io:<port>`; `http://localhost:<port>` also works |
| `ui_port` | The loopback port of the console; `4500` by default. The browser opens it at `http://floci.localhost:<ui_port>` (or `http://localhost:<ui_port>`) |
| `storage` | Floci's [storage mode](https://floci.io/floci/configuration/storage/): `memory` (the default: a restart starts empty), `persistent`, `hybrid` or `wal`, which keep state in the `floci-data` volume |

A change reaches sessions (the addresses the skill gives them) when `office sync` writes the resolved settings, without restarting OpenCode; run `office up` to apply it to Floci.

## One endpoint name

`localhost.floci.io` and every name under it resolve to `127.0.0.1` in public DNS, so on the host the endpoint reaches the published port, and AWS clients can use virtual-hosted names such as `<bucket>.s3.localhost.floci.io`. On the compose network the `floci` service answers to the alias `localhost.floci.io`, and Floci listens on the published port there too, so the same endpoint works from the office's container. Floci advertises that name (`FLOCI_BASE_URL`), so the URLs it returns, an SQS `QueueUrl` for one, work from both sides.

Two limits, both checked with Floci 2.5.0:

- A Docker alias isn't a wildcard: in the office's container, `<bucket>.s3.localhost.floci.io` resolves through public DNS to the container's own loopback. Use path-style S3 there, which the AWS CLI already does with an endpoint. Containers Floci starts (Lambda, ECS, EC2) resolve every name under `localhost.floci.io` through Floci's own DNS.
- The name resolves to `::1` as well as `127.0.0.1`, while the port is published on `127.0.0.1` only. curl and the AWS CLI try `::1`, are refused at once and connect over IPv4.

Floci needs no real credentials: sessions pass `AWS_ENDPOINT_URL` and `test` keys per command or test run (see the skill), never office-wide, as the same machine may hold real AWS credentials.

## What it holds

| Path | |
|---|---|
| `compose.yaml` | The `floci` service (`floci/floci:2.5.0`) and the `floci-ui` console (`floci/floci-ui:0.7.0`), both pinned by digest, and the `floci-data` volume. Floci gets the host's Docker socket, its own console launcher off (the console is `floci-ui`), every loopback bind-address setting it documents, and the resource namespace `office-<office name>-floci`, which prefixes and labels (`floci_namespace`) everything it starts, so it never collides with another Floci on the same Docker daemon. EC2's port-forwarding sidecar, which Floci would pull as `alpine/socat:latest`, is pinned by digest. Service images Floci chooses per resource (RDS's Postgres, EKS's k3s, MSK's Redpanda and the like) are left at Floci's defaults |
| `package.yaml` | The settings above, `aws-cli` as a package tool at the version it was tested with, and the `spawns` label Floci puts on what it starts (see "Cleaning up") |
| `plugin/index.ts` | The OpenCode plugin, which `office sync` links as `.opencode/plugins/aws-emulator`. It registers the skill below with this office's endpoint, console address (from the office's container, `http://floci-ui:4500`) and storage mode, and reloads it when the settings change |
| `skills/floci/` | The skill every session gets: pointing the CLI and SDKs at Floci without touching real AWS, health and reset, EC2 instances, and where Floci's docs are |

Services Floci reaches through proxies inside its own container (RDS, ElastiCache, MemoryDB, Neptune) listen on ports this package doesn't publish: they answer on the compose network at `floci:<port>`, not on the host.

## Security

Floci is an unauthenticated API that accepts any credentials. The package publishes its endpoint and console on `127.0.0.1` only, but:

- **Floci controls the host's Docker.** It gets `/var/run/docker.sock`, which Lambda, RDS, ElastiCache, ECS and EC2 need, and anything with that socket can start a container with the host's filesystem mounted. Anyone who can call the endpoint can make Floci start containers.
- **EC2 instance containers run privileged**, and systemd-based guests get the host kernel's modules folder, so user data or an AMI can load kernel modules into the host. Run only workloads you would run on the host itself.
- **Some ports are published on every interface, not loopback.** Floci 2.5.0 has no bind-address setting for EC2 instance SSH (host ports 2200–2299) or security-group ports (30000–30999, one `socat` sidecar per opened port); Docker publishes them on `0.0.0.0` and `[::]`, which was checked with a running instance. Floci's docs describe the same direct binding for EKS API servers (6500–6599), OpenSearch (9400–9499) and Amazon MQ (5672–5699, 15672–15699). On a machine reachable from other networks, firewall those ranges or keep such resources off. `FLOCI_SERVICES_EC2_PUBLISH_SECURITY_GROUP_PORTS=false` (set in the office's own `compose.yaml` for the `floci` service) stops only the security-group ports; SSH ports are still published.

## Cleaning up

What Floci itself starts isn't part of the compose project: containers (EC2 instances, the `socat` sidecars of security-group ports, Lambda, RDS and the rest), the Docker networks backing EC2 VPCs, and volumes such as `floci-aws-<namespace>-ec2-volumes`. Floci labels each one `floci_namespace=office-<office name>-floci`, which the package declares as its `spawns` label, so `office down`:

1. removes every container with the label, running or stopped, before stopping the office's services, so none keeps Compose from removing the office's network;
2. stops `floci` and `floci-ui` as for every package;
3. removes every network with the label.

So **EC2 instances don't survive `office down`**, in any storage mode: a persistent mode keeps Floci's records of them, but their containers are gone. The volumes stay, as `floci-data` does: they hold EBS volumes and the databases of persistent storage modes. Nothing in `office` removes a package's volumes; delete them with `docker volume rm` once you no longer want them (`docker volume ls --filter label=floci_namespace=office-<office name>-floci` lists Floci's).

Removing the package from `office.yaml` and running `office up` does the same for it. Stopping only its services by hand (`docker compose stop`) leaves what Floci started; `office check` warns about such containers and networks while `floci` and `floci-ui` are stopped, and `office down` removes them. Floci's docs say it also removes, when it next starts, the instance containers and VPC networks of its own that its state no longer holds.

## Upgrading Floci

The releases are pinned in `compose.yaml`, so a new `office` with a newer Floci changes it in `.office/packages/aws-emulator/` on `office sync`. `office up` keeps running the applied copy until `office up --upgrade`, which backs up `floci-data` and starts the new release. The `aws-cli` version is the office's from the start: `office upgrade-tools` moves it, and sync only raises it to the version the package declares.
