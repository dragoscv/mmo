# MixAI Live — the ASIO licence: what to sign, and what it obliges

**Status: not signed.** The SDK is on this machine only (`E:\asio\ASIOSDK`, outside the repository). Nothing
built with it may be distributed — a free beta included — before both parties have signed: the licence becomes
effective on the two signatures (§9.1), and a preview or beta SDK may not be published at all (§2.2).

This page is the signing pack: the two documents were read in full on 2026-11-14 from the SDK package itself,
so the field names, the obligations and the two attribution strings below are quoted, not remembered. The
earlier reading was of Steinberg's public FAQ; where the two differ, this page follows the PDFs.

## The documents

| Document | Where | Version |
|---|---|---|
| `Steinberg ASIO Licensing Agreement.pdf` | `E:\asio\ASIOSDK\` | agreement 2.0.5, SDK 2.3.4 – 15.10.2025, 8 pages |
| `Steinberg ASIO Usage Guidelines.pdf` | same folder | SDK 2.3.4 – 16.10.2025, 4 pages — the logo rules, an annex to the agreement |
| `Steinberg ASIO Logo Artwork\` | same folder | 7 files: `ASIO-compatible-logo-Steinberg-®-white-transparent-RGB.{png,svg}` (dark surfaces), `ASIO-compatible-logo-Steinberg-TM-BW.{svg,png,pdf,jpg,eps}` (light) |

Terms worth knowing before signing: **royalty-free, no fees of any kind** (§4); **unlimited term** (§9.2);
Steinberg may terminate on 36 months' notice, or on 6 months' notice when it publishes a new agreement version
(§9.3–9.6); **German law, jurisdiction Hamburg** (§10.6); no notary or special form (§10.7); signing supersedes
any earlier ASIO agreement (§1.2, §9.7); one agreement covers every product of the licensee; the Licensee also
consents to Steinberg using the licensing data for its own purposes (§10.2).

## The fields, as the form asks for them

Page 1 (identity) and page 8 (signatures):

| Field | Note |
|---|---|
| Company or Organization | **the licensee is a company or an organization, not a private person** — the form has no individual line (the FAQ suggests otherwise; the PDF wins). A sole trader or a PFA has to decide what goes here, and that name is what the licence, the tax records and the store listings will point to |
| Represented by | the person signing |
| Address / City, zip code / Country | the licence address |
| By / Title / Date executed / Printed Signature | the signature block; an electronic signature is accepted (FAQ) and no special form is required (§10.7) |
| Technical contact: Name, Address, Phone, Fax, Email | a second block, separate from the signatory |

Send the completed and signed PDF by e-mail to `sdklicenseagreements@steinberg.de` (the address the FAQ names;
Steinberg's own reception is `reception@steinberg.de`, fax +49 40 21035 300). Steinberg countersigns and returns
it; they ask not to enquire during the first 30 days.

**Draft mail** — fill the brackets, attach the signed PDF:

```text
To: sdklicenseagreements@steinberg.de
Subject: ASIO SDK Licensing Agreement 2.0.5 — signed by [Company or Organization]

Dear Sir or Madam,

Please find attached the Steinberg ASIO SDK Licensing Agreement 2.0.5 (SDK 2.3.4), signed on [date]
by the undersigned on behalf of [Company or Organization].

  Company or Organization: [legal name]
  Represented by:          [name], [title]
  Address:                 [street], [city, zip], [country]
  Technical contact:       [name], [e-mail], [phone]

The product is a Windows audio application that hosts ASIO drivers ("ASIO Driver Compliant Product");
ASIO support is an opt-in, manually activated mode. No part of the SDK is redistributed.

Please return the countersigned agreement. Thank you.

Kind regards,
[name]
```

## What signing obliges — and where each obligation lands

The guidelines (§1) require the ASIO Compatible Logo (or, where space forbids, the attribution text) on every
place a product that uses the SDK is shown: packaging (not applicable — software only), **every website page**
that references the product, **all product documentation**, marketing material, **the dialog that configures
ASIO** (ASIO is activated manually here, so the rule is the dialog itself, not a splash screen), the imprint or
legal page, and — §15 — the attribution in all product credits and documentation with the ® on the first use of
"ASIO" in any product material.

| Place | Today | With the licence |
|---|---|---|
| the dialog that enables ASIO | `apps/live/desktop/src/components/SetupWizard.tsx` — the host picker lists every host, ASIO included | logo + notice in that dialog (`setup.host`, `setup.hostAuto` strings are already localised RO/EN) |
| the About surface | no About box or help menu exists in the app | §1.e accepts the configuring dialog as the equivalent; if an About box is added later, it needs the logo too |
| documentation | `docs/live/latency.md` names ASIO throughout, and `docs/live/cli.md` | logo **or** the attribution sentence; the SDK PDFs are read by developers, not shipped |
| the product website | the Live page and the imprint on `mixai.ro`, and the docs site | logo on every page that mentions ASIO; the imprint needs the notice as well (§1.g) — a site-wide footer is explicitly not enough (§1.b) |
| the repository | no SDK file, and none may be committed (§2.3) | unchanged — the `asio` feature stays opt-in and CI cannot build it |

Two attribution strings, both verbatim from the package — they differ, so use the longer one and add the
registered sign; the stricter reading satisfies both:

- agreement §3.1.k: `ASIO is a trademark of Steinberg Media Technologies GmbH, registered in Europe and other countries`
- guidelines §15: `ASIO is a registered trademark of Steinberg Media Technologies GmbH.`

Permitted and forbidden (§6, §7, §10, §13 of the guidelines): plain-text "ASIO" next to the logo is allowed —
in a product name too ("MixAI Live for ASIO"), as long as the logo is adjacent and "ASIO" is not stylised,
merged into the product brand or the logo; **never in a company name, a company logo, or in a variant form**
("ASIOd", "ASIOi"). The logo may not be altered; the text-under-logo variants in the guidelines are the only
allowed combinations.

## What is blocked until the countersignature

- Any distributed build containing ASIO code: the public installer, a beta, a store listing, a release page.
  The local build for the owner's own use is development and internal testing, which §2.1 permits as soon as
  the SDK is obtained (that was the download) — but publishing is a right granted by the signed agreement.
- Placing the logo in the public documentation or on the site: the logo is part of the licensed SDK, so it may
  be used under the licence, not before it. The attribution sentence may be prepared in the repository meanwhile.
- Shipping the SDK itself: never (§2.3, §2.4), in the repository or inside a package.

After countersignature, the three surfaces above can be built in one pass (dialog, docs, site + imprint), then
the ASIO tier may leave this PC.
