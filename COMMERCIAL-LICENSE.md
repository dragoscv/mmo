# Commercial License

## Summary

The MixAI / MMO core — **MMO Server** (`server/`) and the MixAI web app
(`apps/web/`) — is licensed under **GNU Affero General Public License v3.0
only** (AGPL-3.0-only — see [`LICENSE`](LICENSE)). The client SDK
(`packages/sdk/`) is **MIT**, so third-party clients and plugins are
unencumbered. Decision record: [ADR-0007](docs/adr/0007-licensing-agpl-core-mit-sdk.md).

For most use cases — self-hosting MMO Server on your Raspberry Pi / PC /
Docker, contributing fixes, learning from the code — the AGPL is what you
want and you don't need to read further.

The AGPL is **strong copyleft**. If you modify the core and run it as a
network service (e.g. host your own instance for paying customers), you must
release the **complete source of your modified version** under the same AGPL.

A separate **commercial license** is available for organizations that want to:

- Embed MMO Server / MixAI (or substantial parts) in a closed-source product
- Offer a hosted SaaS based on the core without releasing their modifications
- Distribute MMO Server bundled with proprietary plugins / extensions
- Get prioritized support, security advisories before public disclosure, and
  guaranteed bug-fix turnaround

The commercial license also covers the **MixAI cloud** (hosted instance at
<https://mixai.ro>) and **MixAI Pro** features, which are offered under these
proprietary terms rather than the AGPL.

The names and logos “MixAI” and “MMO Server” are **not** covered by either
licence — see [`TRADEMARKS.md`](TRADEMARKS.md).

## Why dual-license?

It funds continued development. The hosted MixAI cloud at <https://mixai.ro>
is the project's primary revenue source. A commercial license lets companies
build proprietary derivatives without the AGPL's source-disclosure obligation
in exchange for a contribution to that funding.

## Pricing

Pricing is per-organization and depends on:

- Whether you're shipping a product or running a SaaS
- Number of seats / monthly active users
- Required support tier

Indicative entry tiers:

| Tier         | Use case                                | Annual fee (EUR) |
|--------------|-----------------------------------------|------------------|
| Startup      | < 10 employees, < €1M ARR               | from 500         |
| Growth       | < 50 employees, < €10M ARR              | from 5,000       |
| Enterprise   | larger orgs, custom SLA                 | contact us       |

Indie developers shipping an open-source derivative under AGPLv3 do **not**
need a commercial license — the AGPL is fine.

## How to obtain one

Email **license@mixai.ro** with:

1. Company name + country of registration
2. Brief description of the intended use
3. Approximate scale (seats, MAU, hosted vs distributed)
4. Required support tier

You'll get a quote and a draft agreement within a few business days.

## What you get

A signed, perpetual (or annual, if you prefer renewable) license that
grants you the right to use the MMO Server / MixAI core under proprietary
terms instead of the AGPL-3.0, plus your chosen support tier. The AGPL-3.0
source remains publicly available and the dual-license has no effect on
other users.

---

© 2026 Dragos Catalin Vladulescu (vladulescu.catalin@gmail.com). All rights reserved.
