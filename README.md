
# Test Your Catena

Test and validate SMPTE ST 2138 Catena devices over REST or native gRPC.

## 1. Use a GHCR container

The multi-architecture image is `ghcr.io/rossvideo/st2138-tester`. It supports
`linux/amd64` (x86-64) and `linux/arm64` (aarch64); Docker selects the host
architecture automatically.

| Tag | Contents |
| --- | --- |
| `dev-latest` | Most recent `dev` build |
| `dev-YYYYMMDD` | Most recent `dev` build for that UTC date |
| `dev-YYYYMMDD-SHA` | Specific `dev` build, identified by commit SHA |
| `latest` | Most recent `main` build |
| Version in `version.md` | Versioned `main` build |

Use `dev-latest` for ongoing testing, or use a date/SHA tag to pin a specific
build. Only the three newest dev image versions are retained. Use `latest` for
the most recent `main` image:

```sh
docker pull ghcr.io/rossvideo/st2138-tester:dev-latest
docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/rossvideo/st2138-tester:dev-latest
```

Open http://localhost:3000. Press `Ctrl+C` to stop the container. If the GHCR
package is private, authenticate with `docker login ghcr.io` first. Set the
package visibility in GitHub Packages if anonymous pulls should be allowed.

Updates to `dev` move `dev-latest`, publish date and date-plus-SHA tags, and
prune dev images older than the three newest versions. Updates to `main` publish
the same image as `latest` and the version in `version.md`. Keep that file in
sync on both branches with the ST 2138-a submodule version; change it only when
updating the submodule. See [Deployment](DEPLOYMENT.md) for publishing and
platform details.

The container binds to localhost in these examples. The app has no sign-in,
CAPTCHA, or application-level rate limit, and it makes outbound requests to the
device URL entered by the user. Do not expose it directly to the Internet without
authentication, access controls, and restricted outbound destinations. Only
test devices you are authorized to use; scans can change device values.

## 2. Use the tester

1. Enter the Catena device base URL, then choose **REST** or **gRPC**.
2. Select **Use JWT** for an authorization-enabled device and paste the compact
	token without a `Bearer` prefix.
3. Select **Start scan** and review the report by slot and API endpoint.

The scan discovers populated slots, retrieves each device model, and validates
it with the vendored ST 2138-a validator. It reads and tests declared parameters
with GET/SET operations, verifies changes, and attempts to restore original
values. REST safe OpenAPI operations are also checked. Operations without a safe
restore path are reported but not run automatically. Commands run only when you
press their individual **Run** button; mutating manual requests require
confirmation.

The report includes schema results, parameter and endpoint checks, response
validation details, and device metadata. Reports and device payloads stay in the
browser for the current run; they are not saved as server-side history.

JWTs are sent as REST `Authorization: Bearer` headers or gRPC authorization
metadata. They are cleared when changing devices and redacted from reports. The
device validates the token and its scopes. **Allow insecure TLS** is off by
default; enabling it disables certificate and hostname verification for that
device connection. Prefer trusted certificates.

## 3. Develop the project

Use Node.js 24 LTS. Clone the `dev` branch with its validator submodule, install
dependencies, and start the local server:

```sh
git clone --branch dev --recurse-submodules https://github.com/rossvideo/st2138-tester.git
cd st2138-tester
npm ci
npm run dev
```

Open http://localhost:3000. Run the tests and compile/package the app with:

```sh
npm test
npm run build
```

Unit tests, the build, CodeQL analysis, and `npm audit` run on every branch push
and on PRs targeting `dev` or `main`. Dependabot checks npm, Dockerfile, and
GitHub Actions dependencies daily and opens update PRs against `dev`;
Dependabot's update service is scheduled, not triggered by each push.

To build and run the local Docker image instead:

```sh
docker compose up -d --build
docker compose logs -f app
docker compose down
```

The validator schemas, OpenAPI definitions, and protobuf files come from the
`vendor/st2138-a` submodule. Initialize it with `git submodule update --init
--recursive` if it is missing. Device discovery uses REST
`GET /st2138-api/v1/devices` (with `/st2138-api/v1/device` as a fallback) or the
gRPC `CatenaService.GetPopulatedSlots` and `DeviceRequest` methods.

See [Deployment](DEPLOYMENT.md) for architecture-specific builds, operations,
resource limits, network safety, and security scans.