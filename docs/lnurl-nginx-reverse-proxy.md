## NGINX reverse proxy for LNURL (LUD-16)

This document provides a technical reference for how the NGINX reverse proxy setup maps to the [LUD‑16](https://github.com/lnurl/luds/blob/luds/16.md) specification.

For complete installation and setup instructions, see [INSTALL.md](../INSTALL.md).

---

### How this maps to LUD‑16

Per [LUD‑16](https://github.com/lnurl/luds/blob/luds/16.md), a wallet resolving an internet identifier like:

- `alice@example.com`

must call:

- `https://example.com/.well-known/lnurlp/alice`

In this project:

- NGINX receives that request and proxies it to the NestJS app
- `LnurlController.getLnurlPayMetadata` returns a `payRequest` response (LUD‑06) with:
  - `callback` → `https://example.com/lnurl/callback/alice`
  - `minSendable` / `maxSendable`
  - `metadata` including identifier info (e.g. `alice@example.com`)
- The wallet then calls `callback` with `amount=<msat>`, which NGINX again forwards to the app (`LnurlController.handleLnurlCallback`), completing the LNURL‑pay flow.

The important LNURL endpoint is:

- `GET /.well-known/lnurlp/:username` → handled by `LnurlController` in `src/lnurl/lnurl.controller.ts`

NGINX must expose this path on your public domain and forward it to the NestJS app.
