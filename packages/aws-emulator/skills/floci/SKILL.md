---
name: floci
description: Run AWS CLI and SDK calls against the office's local AWS emulator, Floci, instead of a real account. Use when testing or experimenting with AWS services (S3, SQS, DynamoDB, Lambda, EC2 and others), writing tests that call AWS, or when the user mentions Floci or a local AWS.
---

# Floci

The office runs [Floci](https://floci.io/floci/), a local emulator of the AWS APIs. It accepts any credentials and touches no real account. "This office's Floci" below gives its endpoint and console.

## Pointing a client at it

The user also works with real AWS from this machine, so every call is one aimed on purpose. Scope the emulator's settings to the command or the test run, never to a shell profile, an `.env` the user's tools share, or `~/.aws`:

```sh
AWS_ENDPOINT_URL=<endpoint> AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 aws s3 ls
```

SDKs read the same four variables; set them in the test runner's environment or pass `endpoint` and static credentials to the client. Only `AWS_ENDPOINT_URL` keeps a call off real AWS: without it, `test` credentials still go to amazonaws.com and fail, and real ones would act on the user's account.

- Run tests and experiments against Floci only.
- Before a destructive command (delete, terminate, purge, reset), confirm the endpoint in that same command is Floci's.
- In the office's container, and any container but those Floci starts, bucket subdomains such as `<bucket>.s3.localhost.floci.io` resolve to that container itself, not Floci: use path-style S3 there. The CLI already does with an endpoint; SDKs need it set (`forcePathStyle: true` in JavaScript, `addressing_style: "path"` in boto3).
- An access key of exactly 12 digits becomes the account ID, giving a separate account; `test` is account `000000000000`.

## Health and reset

- `curl <endpoint>/_floci/health` reports the version and each service's state.
- `curl -X POST <endpoint>/_floci/state/reset` wipes every service's state at once, stops the containers Floci started, and re-creates the defaults (default VPC and the like). It is all or nothing: other sessions' resources go too, so tell the user before you run it.

## EC2

Instances are real Docker containers. AMI IDs map to images through Floci's catalog: `ami-amazonlinux2023`, `ami-ubuntu2404`, `ami-debian12`, `ami-alpine`, among others. An unknown ID, a real AWS AMI ID included, falls back to Amazon Linux 2023. With `--key-name`, SSH listens on a host port from 2200 to 2299; `describe-instances` and Floci's log say which. Terminate what you launch.

## Looking things up

Floci's docs at https://floci.io/floci/ cover each service's supported operations, its configuration and its limits; check them when a call behaves unlike AWS.
