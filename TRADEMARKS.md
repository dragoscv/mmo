# Trademark Policy — MixAI

The source code in this repository is licensed under the AGPL-3.0-only
(core) and MIT (`packages/sdk`) — see [`LICENSE`](LICENSE),
[`packages/sdk/LICENSE`](packages/sdk/LICENSE) and
[ADR-0007](docs/adr/0007-licensing-agpl-core-mit-sdk.md).

**Those licences cover the code only.** The name **MixAI**; the product names
**MixAI TV**, **MixAI Music**, **MixAI Decks**, **MixAI Live**, **MixAI Studio**,
**MixAI Key & BPM**, **MixAI Server** and **MixAI Connector**; **MMO Server**
(the technical name of MixAI Server) and the earlier names **MixAI Companion**
and **MixAI DJ**; the `mixai.ro` domain; and the associated logos, product
icons, logo animations and startup sound (the "Marks") are trademarks of
Dragos Catalin Vladulescu and are **not** licensed under the AGPL or MIT. This
policy explains what you may and may not do with them. It is modelled on the
branding policies of other open-source media servers (Jellyfin, Immich).

How the Marks look and how they are written: [`brand/BRAND.md`](brand/BRAND.md).
The files under `brand/` and every generated icon in this repository are part
of the Marks: they ship with the source so official builds can be reproduced,
not so they can be reused.

## You may, without asking

- Use the Marks to **truthfully refer to** the project: "compatible with MixAI
  Server", "a client for MixAI", "built on MMO Server", "forked from MixAI".
- Use the unmodified logo when **linking to** <https://mixai.ro> or
  <https://github.com/dragoscv/mmo>.
- Use the Marks in **articles, talks, reviews, tutorials** and package
  descriptions that describe the software.
- Distribute **unmodified** official builds under their original name.
- Run an **unmodified** MixAI Server for yourself, your family or your
  organisation and call it MixAI Server.

## You may not, without written permission

- Use the Marks (or confusingly similar names such as "MixAI Cloud",
  "MixAI Pro", "MixAI Server Plus", "MMO Server Plus", "MixAi", "Mix-AI") as the name of a
  **modified** build, a fork, a hosted service, an app-store listing, a
  browser extension, a domain name or a social-media handle.
- Ship a **modified** version under the MixAI / MixAI Server / MMO Server name
  or with the official icons. Rename it and replace the icons — your fork is
  welcome, our name on it is not.
- Use the Marks in a way that implies **endorsement, partnership or official
  status** ("official MixAI hosting", "certified for MixAI").
- Sell merchandise, courses or support bearing the Marks as your own product.
- Alter the logo or a product icon (colours, proportions, added elements,
  other animations) except for proportional scaling.

## Forks and derived works

Forks are encouraged — that is what the AGPL is for. A fork must use its own
name and icons: replace the generated files listed by
`node brand/scripts/build.mjs --list` with your own. You may say "based on
MixAI Server" in a subtitle or the About screen, and you must keep the
copyright and licence notices intact.

Third-party clients built on the MIT-licensed `packages/sdk` may state
compatibility ("works with MixAI Server") but must not present themselves as
MixAI apps.

## Hosted services

Offering MixAI Server as a hosted service to third parties is allowed under
the AGPL (with source disclosure of your modifications). It must be marketed
under **your** name; the official hosted product is the MixAI cloud at
<https://mixai.ro>. See [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md) for
proprietary terms.

## Requesting permission

For anything not covered above, or if you are unsure, email
**license@mixai.ro** with a description of the intended use. Permission is
usually granted for community projects, meet-ups and non-commercial uses.

## Changes to this policy

This policy may be updated; the version in the `main` branch of
<https://github.com/dragoscv/mmo> is authoritative.

© 2026 Dragos Catalin Vladulescu. All rights reserved.
