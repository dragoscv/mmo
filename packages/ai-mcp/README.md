# @mmo/ai-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server exposing MMO's Maestro tool catalogue.

External MCP clients (Claude Desktop, Cursor, VS Code MCP, Zed, etc.) can connect and drive any user's MMO instance — create projects, generate audio, mix tracks, render songs — by authenticating with a PAT issued from `/settings/copilot → Developer → Tokens`.

## Transports

- **stdio** — for local desktop clients (Claude Desktop, Cursor)
- **HTTP + SSE** — for web / remote clients
- **WebSocket** — legacy MCP transport, optional

## Scopes

- `daw:read` — read project/track/clip state
- `daw:write` — mutate the DAW
- `generate:audio` — run audio generation tools
- `generate:midi` — run MIDI generation tools
- `library:read` / `library:write` — library access

## Status

Scaffolded in P0. Full transport implementations land alongside Maestro in P4 / platform façade in P11.
