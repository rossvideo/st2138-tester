# Deployment

## Build and run

```sh
git submodule update --init --recursive
npm ci
npm test
npm run build
docker compose up -d --build
```

Use Node 24 LTS. The build copies the UI into `dist/ui`. Rebuild after source
changes. There are no development bind mounts in production.

## GitHub image publishing

Updates to `dev` publish `ghcr.io/rossvideo/st2138-tester` for `linux/amd64`
and `linux/arm64`, move the `dev-latest` tag, and publish `dev-YYYYMMDD` and
`dev-YYYYMMDD-SHA` tags. The workflow retains only the three newest dev image
versions and does not delete `main` tags. Updates to `main` publish the same
multi-architecture image as `latest` and the version in [version.md](version.md),
then increment the patch version in a bot commit. The GitHub Actions workflow
needs permission to write packages and push the version bump to `main`; branch
protection must allow that bot push. Set the GHCR package visibility separately
if the image should be public.

## Security automation

CodeQL, the root npm dependency audit, and the unit tests/build workflow run only
for pull requests targeting `dev` and `main`, not on branch pushes or a schedule.
Dependabot checks npm, Dockerfile,
and GitHub Actions dependencies daily and targets update PRs at `dev`. GitHub
Dependabot updates are schedule-based; `npm audit` provides the dependency check
on each pull request to `dev` or `main`.

### Architecture-specific images

The Dockerfile supports Linux x86-64 (`linux/amd64`) and aarch64
(`linux/arm64`). Compose builds for the Docker host's architecture by default,
so `docker compose up -d --build` also works directly on an aarch64 host.

To cross-build and run an ARM image on an x86-64 Linux Docker Engine, first
enable ARM emulation if the builder does not already support it. Docker Desktop
includes emulation; a standalone Engine may need the following one-time setup.
The installer is privileged and changes host-wide binary-format handlers; run it
only with the Docker host administrator's approval:

```sh
docker run --privileged --rm tonistiigi/binfmt --install arm64
docker buildx inspect --bootstrap
```

Check that the builder lists `linux/arm64`, then build with a separate tag so
the existing local x86-64 image is not replaced:

```sh
docker buildx build --platform linux/arm64 --load -t test-your-catena:local-arm64 .
docker image inspect test-your-catena:local-arm64 --format '{{.Os}}/{{.Architecture}}'
docker run --rm --platform linux/arm64 -p 127.0.0.1:3000:3000 test-your-catena:local-arm64
```

The inspection must print `linux/arm64`. In another terminal, verify readiness
with `curl --fail http://localhost:3000/health`. Stop any existing tester on
port 3000 first, or publish a different host port. Cross-builds run the same
regression tests and TypeScript compilation natively on the build host. The
runtime stage installs production dependencies for the target architecture;
that stage and running the ARM image on x86-64 require emulation.
`--load` imports this single-platform image into the local Docker image store;
it does not publish it to a registry.

To transfer the built image to an aarch64 host without rebuilding:

```sh
docker image save -o test-your-catena-arm64.tar test-your-catena:local-arm64
# Transfer the tar file to the aarch64 host, then run there:
docker image load -i test-your-catena-arm64.tar
docker run -d --name test-your-catena-arm64 --restart unless-stopped \
  --platform linux/arm64 --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 128 --memory 1536m --cpus 2 \
  -p 127.0.0.1:3000:3000 test-your-catena:local-arm64
```

## Network access

Compose binds to `127.0.0.1` by default. Set `PORT` to change the published port.
The container connects to the Catena device URL entered by its user. Scans can
change device values, so only use authorized test devices. Automatic parameter
checks temporarily change values; if a worker is interrupted, verify device
state manually.

The image may be published to a public container registry. That does not make the
web service safe for public access: it has no sign-in or CAPTCHA, and it makes
outbound requests to user-supplied device URLs. Before
public service exposure, provide ingress authentication and access controls and
restrict outbound destinations; see [Security Review](SECURITY-REVIEW.md). Ingress
authentication alone does not constrain outbound requests. Keep the default
loopback binding unless these controls are in place. The Compose `BIND_ADDRESS`
option changes only the host-side published address; the container continues to
listen on port 3000.

The image runs as an unprivileged user, drops Linux capabilities in Compose,
and disables privilege escalation. The validator schema directory and `/tmp`
must remain writable. No scan history is persisted; browser results are transient.
Container logs can contain device information, so restrict access and retention.
Docker builds run the regression tests before producing the image. npm and Yarn
are intentionally absent from the runtime image; use the builder for tooling.

### Optional insecure device TLS

The unchecked-by-default **Allow insecure TLS** connection option disables device
certificate and hostname verification for HTTPS REST and TLS gRPC. Encryption
remains enabled. It applies to the scan, rescans, commands, and manual endpoint
requests for that connection; changing devices resets it. The UI warns that an
impersonated device can receive JWTs and commands and labels the connection
as TLS unverified. Prefer trusted certificates; use this only for trusted test
devices. It does not change the tester website's TLS or other workers' settings.

## Resource boundaries

All HTTP routes share a limit of 10,000 requests per minute per client IP
(IPv6 clients are grouped by /56 subnet). This includes UI files, health checks,
and every API endpoint. Excess requests receive HTTP 429 with a JSON message,
`Retry-After`, and standard `RateLimit` headers before body parsing or device work.
Active scans are not interrupted by the limiter.

Counters are held in memory per application process and reset on restart.
Express does not trust forwarded client-IP headers by default: clients behind a
reverse proxy share that proxy's limit. Configure proxy trust only for known
ingress infrastructure before relying on forwarded client addresses. Multiple
application instances need a shared rate-limit store or an ingress-level limit.
This request-rate limit does not bound concurrent operations or their resource use.

| Scope | Limit |
| --- | --- |
| Incoming HTTP requests | 10,000 per minute per client IP, shared across all routes |
| Application-level device work caps | None configured for request payload size, worker count, slots, model size, response/stream size, or report size |
| Operation timeouts | REST requests and gRPC calls each have a 1-minute timeout; an operation stops only after 5 minutes with no progress (no total time limit) |
| Scan progress | REST/gRPC scans stream NDJSON progress, with a heartbeat every 5 s that keeps proxy connections active |
| Container resources | Compose CPU, memory, and process limits; see `docker-compose.yml` |

Each device operation runs in a separate worker, which is terminated when the
client disconnects or exceeds its operation timeout. **Termination can interrupt
parameter restoration or a command; verify device state manually after an interrupted
scan.** Application-level work is unbounded and can exhaust the configured container
resources. Use test devices, monitor the container, and keep access restricted to
trusted operators.

## Operations

```sh
docker compose ps
docker compose logs app
curl --fail http://localhost:3000/health
docker compose down
```

The image health check verifies HTTP readiness. Rebuild regularly to consume
security updates, scan the new image before release, and retain a known-good
image tag for rollback. Do not store secrets in the downloaded source package.

## Security scans

```sh
trivy fs --scanners vuln,misconfig,secret --include-dev-deps --skip-dirs node_modules,dist,old-src,reports,vendor/st2138-a/tools/node_modules --format json --output reports/trivy-filesystem.json .
trivy image --scanners vuln,misconfig,secret --format json --output reports/trivy-image.json test-your-catena:local
trivy image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 test-your-catena:local
```

In the project checkout, create a `reports` directory before scanning. See
the JSON outputs for recorded results. Reports are not bundled in the source
download. Dependency scanning does not establish that the application is safe for
unauthenticated public access. Apply authentication and access controls at the
ingress before exposing the service beyond trusted operators.