
# Test Your Catena

A local web application for scanning and validating SMPTE ST 2138 Catena devices.

## Development

```sh
npm install
npm run dev
```

Open http://localhost:3000. Enter a device base URL and choose REST or gRPC. The scan discovers populated slots, retrieves each full device model, runs the vendored `st2138-a` validator, and GET/SET tests every declared parameter except commands. For gRPC, omitted proto3 defaults such as `read_only: false` are restored before testing. Each SET uses a different value where possible, checks the value afterward, and restores/verifies the captured original whenever a change is observed or state is uncertain, including parameters marked read-only. A read-only parameter passes when SET is rejected and the value remains unchanged. REST also checks safe OpenAPI operations; command routes are excluded from scanning and other mutating endpoint operations are listed but not run.

The report summarizes device-wide endpoints separately from per-slot endpoints. Slots are displayed in numeric order. The full summary shows pass/fail percentages and counts for every tested endpoint audit record plus one completed schema result per slot; skipped endpoints are excluded. Parameter value audit records are included once in these endpoint totals. Each slot row shows the vendor/product name, version, serial number, schema validation status, and endpoint pass/fail counts; a slot fails if any tested endpoint fails. Validation details remain visible, with parameter checks and API endpoint summaries grouped in collapsed sections; opening an API row shows its outcome, response validation, request, and response. Read-only parameters are labeled in both parameter and endpoint rows. Manual endpoint forms omit the request-body editor for bodyless operations such as GET, while retaining the manual run control. REST and gRPC reports group subscription operations together and language-pack operations by language. Member descriptor and metadata reads appear alongside value reads and guarded updates by slot, member type, and FQOID. Mutating requests require confirmation. Automatic and manual REST/gRPC responses, including command and parameter results, are validated against the applicable ST 2138 schema/protocol shape, with validator diagnostics shown in the report. REST ParamInfo uses its OpenAPI response schema; gRPC ParamInfo uses the protobuf `ParamInfo` fields. The Commands tab runs a command only after its Run button is pressed; an optional JSON body can be supplied and the device response is shown inline.

The Ross-branded header links to the ST 2138-a documentation and project, and shows the connection LED, full device URL, and selected transport after a successful scan. The scan report repeats the full URL and transport for context.

Scan reports and device payloads are held in the browser only for the current run. They are not saved as server-side history.

For an authorization-enabled device, check **Use JWT** below the device URL and
paste the compact token without a `Bearer` prefix. The selected token is sent as
REST `Authorization: Bearer` headers or gRPC `authorization` metadata for scans,
commands, and manual requests. It is held only for the current browser connection,
cleared when changing devices, and redacted from reports. Keep app access
restricted to trusted operators, and use encrypted device connections for
sensitive credentials; the device, not this app, verifies the token and its scopes.

## Docker

The `vendor/st2138-a` submodule must be initialized before building the image.

```sh
docker build -t test-your-catena .
docker run --rm -p 127.0.0.1:3000:3000 test-your-catena
```

Then open http://localhost:3000.

The same Dockerfile supports Linux x86-64 (`linux/amd64`) and aarch64
(`linux/arm64`). The default build uses the Docker host's architecture.
To build a separate aarch64 image, including from an x86-64 host with ARM
emulation enabled:

```sh
docker buildx build --platform linux/arm64 --load -t test-your-catena:local-arm64 .
docker run --rm --platform linux/arm64 -p 127.0.0.1:3000:3000 test-your-catena:local-arm64
```

See [Deployment](DEPLOYMENT.md#architecture-specific-images) for emulation setup,
verification, and transferring the image to an aarch64 host.

For the localhost-only production Compose setup, run `docker compose up -d --build`.
See [Deployment](DEPLOYMENT.md) for installation, network safety,
release checks, and operations. The image may be distributed publicly, but the
unauthenticated service should not be exposed directly to the Internet. It has no
sign-in, CAPTCHA, or application rate limiting; restrict access to trusted operators.

## Device interfaces

- REST discovery uses `GET /st2138-api/v1/devices` with `/st2138-api/v1/device` as a fallback, then fetches `/st2138-api/v1/{slot}`.
- gRPC uses the vendored `CatenaService.GetPopulatedSlots` and streams `CatenaService.DeviceRequest` at `FULL` detail.
- REST safe OpenAPI operations, including every advertised language pack, and gRPC parameter, metadata, and language reads appear in the API report. Other non-command operations without a guaranteed restore path are marked not run with a reason.
- Both protocols run each retrieved slot model through the vendored `st2138-a` validator library.


Protocol definitions, OpenAPI documents, and schemas are supplied by the `st2138-a` submodule.