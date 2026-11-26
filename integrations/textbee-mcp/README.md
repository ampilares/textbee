# Self-hosted TextBee MCP for Grok Bot

Remote MCP URL: **https://textbee.allenmaripilares.com/mcp**

Deployment verified: the service is healthy and the public route is active.
Requests without a key return HTTP 401 with instructions for the header; invalid
keys are rejected with HTTP 401. The API health route returns HTTP 200. A valid
production key and an actual Grok Bot connection have not yet been tested.

This service wraps the official `@textbee/mcp` tools with MCP Streamable HTTP. It
always talks to `https://textbee.allenmaripilares.com/api/v1`; callers cannot choose
another API server. It is independent of the Android APK and existing web/API builds.

## Connect from Grok Bot on another machine

In Grok Bot, open **Connect apps → Add a custom connector**:

- Name: `TextBee`
- Type: **Remote HTTPS**
- Server URL: `https://textbee.allenmaripilares.com/mcp`
- HTTP header name: `x-textbee-api-key`
- Header value: your API key from **your self-hosted TextBee dashboard**.
- Leave OAuth Client ID/secret unset: this connector uses an API-key header.

Enter the key privately in connector settings or Grok's secure secret card. Do not
paste it into ordinary chat or put it in the URL. A key from the public textbee.dev
service will not authenticate against your self-hosted instance.

You can ask Grok Bot:

> Add a Remote HTTPS MCP connector named TextBee using
> https://textbee.allenmaripilares.com/mcp. Ask me securely for the TextBee API key
> and set it as the x-textbee-api-key header. Test the connection by listing
> devices only; do not send a message.

The official Grok Bot documentation confirms custom connectors support a remote
HTTPS URL and optional HTTP headers:
https://docs.x.ai/grok-bot/computer-and-apps

## Tools

| Tool | Action |
| --- | --- |
| `list_devices` | Read the Android phones registered to the account. |
| `get_messages` | Read sent/received messages, with filters and pagination. |
| `send_sms` | Send to the user's specified recipients through their Android phone. |

The Android phone must be paired and online for real delivery. SMS sends consume
carrier/plan quota. A timed-out send must not be retried automatically: this gateway
does not promise exactly-once delivery or persist a deduplication store.

## Authentication and behavior

Every MCP POST requires `x-textbee-api-key`. The gateway verifies the supplied key
against the fixed API's read-only `/gateway/devices` route before invoking MCP.
Revoked/invalid keys return HTTP 401; there is no credential cache or persistent key
store. The header is converted to the API's `x-api-key` header only for the configured
API. It is not an OAuth bearer-token passthrough. No API key is set in the service's
environment, image, Compose file, or repository.

Each HTTP request gets its own MCP server and credentials. The service does not log
keys, message bodies, request headers, or raw upstream errors. Tool output redacts
any reflected caller key. Credentialed outbound requests cannot follow redirects
or leave the configured API root. The server validates Host/Origin and limits JSON
bodies to 256 KiB. No session ID is issued; GET/DELETE are not used by this stateless
transport. `/healthz` is an internal unauthenticated liveness endpoint.

## Run and test

Requires Node 22+ for local development:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests use mock credentials and a loopback mock TextBee API. The simulated send test
does not send SMS or contact the production API.

For local development, set `TEXTBEE_BASE_URL`, `MCP_PUBLIC_URL`, and optionally
`HOST` (default `127.0.0.1`) and `PORT` (default `3102`), then `npm start`.
Both URLs must use HTTPS, except loopback HTTP for local testing.

For this deployment, from the repository root:

```sh
docker compose -f integrations/textbee-mcp/compose.yaml up -d --build
```

The service joins the existing `textbee-local_default` network and publishes no
host port. It uses a non-root, read-only container with a 256 MiB memory limit.
It does not recreate API, web, database, Redis, or Mailpit containers.

Place this rule before the existing web catch-all in the existing tunnel config:

```yaml
- hostname: textbee.allenmaripilares.com
  path: ^/mcp/?$
  service: http://textbee-mcp:3102
```

Validate the tunnel configuration, then restart only the tunnel connector to load
its route. Existing API/web ingress rules must remain unchanged. Stopping only the
MCP service is `docker compose -f integrations/textbee-mcp/compose.yaml down`.
Remove its tunnel rule first when permanently removing the service.

## xAI API alternative

For a bot built directly on xAI's Responses API, include this in the request's
`tools` array (substitute the header value privately at runtime):

```json
{
  "type": "mcp",
  "server_label": "textbee",
  "server_url": "https://textbee.allenmaripilares.com/mcp",
  "headers": { "x-textbee-api-key": "<read from your secret store>" },
  "allowed_tools": ["list_devices", "get_messages", "send_sms"]
}
```

For a read-only connection, omit `send_sms` from `allowed_tools`. xAI's native SDK
uses `allowed_tool_names` and `extra_headers` instead. The Responses API's
`require_approval` field is not supported by xAI; enforce any desired send approvals
in the bot's application. Reference:
https://docs.x.ai/developers/tools/remote-mcp

Tool implementation: https://github.com/textbee/textbee-mcp (pinned 0.3.0).
MCP SDK is pinned in package-lock.json. Keep dependency updates intentional.
