# Traffic Agent API — telemetry build

Server-only package for the Android traffic agent backend. This version is intentionally verbose in its server logs so the Render logs can show which stage is being reached.

## What gets logged

Every request gets a unique `X-Request-Id` and JSON logs include request/response timing, route, status, user agent, and content length.

The event endpoint additionally logs:

- whether the device-token header was present and whether authentication succeeded (never the token value)
- whether the body was a valid event array
- batch size, hosts, methods, statuses, content types
- Mongo insert duration and inserted count
- errors with stack traces

The server also emits a periodic `telemetry_heartbeat` containing Mongo ping time, counters, and process memory.

`/v1/diagnostics` is protected by the same `X-Device-Token` header and returns counters/configuration/Mongo status. It does not return the device token or Mongo URI.

`LOG_EVENT_DETAILS=false` is the default. Set it to `true` only when you specifically want truncated URL/query values in Render logs.

## Environment variables

Required:

- `MONGODB_URI`
- `DEVICE_TOKEN` (32+ characters)

Optional:

- `DB_NAME` (default `traffic_agent`)
- `COLLECTION_NAME` (default `events`)
- `TTL_DAYS` (default `30`)
- `PORT` (Render supplies `PORT`; default `10000` locally)
- `MAX_BATCH` (default `50`)
- `LOG_EVENT_DETAILS` (default `false`)
- `TELEMETRY_HEARTBEAT_MS` (default `60000`)

## Render

Use Root Directory `server`, Build Command `npm ci`, Start Command `npm start`, and Health Check Path `/healthz`.

After deploy, the Render logs should show startup entries similar to:

- `mongo_connected`
- `creating_indexes`
- `indexes_ready`
- `server_listening`
- `telemetry_heartbeat`

When Android calls the event endpoint, look for this sequence:

1. `request_received` for `POST /v1/events`
2. `event_endpoint_entered`
3. `event_auth_rejected` OR `event_batch_validated`
4. `mongo_insert_succeeded` OR `mongo_insert_failed`
5. `response_sent`

That sequence lets you pinpoint whether the request reached Render, authentication failed, the Android payload was rejected, or MongoDB insertion failed.

## Quick checks

Health:

```text
GET /healthz
```

Expected when Mongo is reachable:

```json
{"ok":true,"mongo":"ok",...}
```

Diagnostics (requires the device token):

```text
GET /v1/diagnostics
X-Device-Token: <your token>
```

Events:

```text
POST /v1/events
X-Device-Token: <your token>
Content-Type: application/json
```

Do not commit `MONGODB_URI` or `DEVICE_TOKEN` to source control.

## Included configured environment

This package also includes a `.env` file populated from the configured project values and `device-token.txt` so the server can be run locally without recreating the environment by hand. Treat this package as sensitive and do not publish or commit it to source control. For Render, copy the `.env` values into Render's Environment settings rather than relying on a local `.env` file.
