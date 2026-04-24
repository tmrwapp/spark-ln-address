## Request signature authentication (v2)

### Background

The original authentication for registering a Lightning address name is a two-step challenge-response flow (`generateAuthChallenge` + `verifyAndBindUsername` in `src/auth/auth.service.ts`): the server issues a random `k1` nonce, the client signs it, and the server verifies. That flow stays in place for backward compatibility with existing wallet clients.

For new authenticated endpoints we use a single-round scheme: the client derives its own nonce from request parts + a timestamp, signs it locally, and sends the signature alongside the request — no prior exchange with the server. Both schemes share the same secp256k1 verifier (`src/auth/secp256k1.utils.ts`).

### Headers

Every protected request carries three headers:

- `x-auth-pubkey` — client's secp256k1 public key, hex-encoded. 33-byte compressed (66 hex chars) or 65-byte uncompressed (130 hex chars). Lowercased server-side before DB lookup.
- `x-auth-timestamp` — Unix millisecond epoch as a decimal string. Rejected if `|now - timestamp| > AUTH_MAX_SKEW_MS` (default 60 000 ms).
- `x-auth-signature` — signature of the canonical message below, hex-encoded. Accepted as DER or 64-byte compact.

### Canonical message

```
{METHOD}:{url}:{timestamp}:{bodyHash}
```

- `METHOD` — HTTP method, uppercase (`GET`, `POST`, `PATCH`, …).
- `url` — `req.originalUrl` verbatim, including any query string (e.g. `/v1/users/me/currency`, or `/v1/things?q=A&sort=desc`). Query params are part of the signed payload, so tampering with them invalidates the signature.
- `timestamp` — the `x-auth-timestamp` header value, used verbatim (not re-parsed).
- `bodyHash` — hex of `sha256(rawBody)` for POST/PATCH/PUT with a non-empty body; empty string otherwise (including GET/DELETE).

Fields are joined with literal `:` and the final string is signed as its UTF-8 bytes (`Buffer.from(message, 'utf8')`). The canonical message is never parsed — client and server independently construct the same bytes from known-format fields (method is a small fixed set, timestamp is numeric, bodyHash is hex), so colon separation is unambiguous without escaping.

Example (PATCH with body `{"currency":"USDB"}`):

```
PATCH:/v1/users/me/currency:1712345678901:b7a2e4c9…d1f8
```

### Client-side construction

```typescript
import { sign, getPublicKey } from '@noble/secp256k1'
import { createHash } from 'crypto'

const privateKey = Buffer.from(privateKeyHex, 'hex')
const pubkeyHex = Buffer.from(getPublicKey(privateKey, true)).toString('hex')

const method = 'PATCH'
const url = '/v1/users/me/currency'
const timestamp = String(Date.now())
const body = JSON.stringify({ currency: 'USDB' })
const bodyHash = createHash('sha256').update(body).digest('hex')

const canonical = `${method}:${url}:${timestamp}:${bodyHash}`
const signatureHex = Buffer.from(
  await sign(Buffer.from(canonical, 'utf8'), privateKey),
).toString('hex')

await fetch('https://api.example.com' + url, {
  method,
  headers: {
    'content-type': 'application/json',
    'x-auth-pubkey': pubkeyHex,
    'x-auth-timestamp': timestamp,
    'x-auth-signature': signatureHex,
  },
  body,
})
```

### Server verification

`SparkSignatureGuard` (`src/auth/spark-signature.guard.ts`) runs on every protected endpoint:

1. Extract and require all three headers, else `401`.
2. Check timestamp skew against `AUTH_MAX_SKEW_MS`, else `401`.
3. Compute `bodyHash` from `req.rawBody` (see body-hash rules above). Server wiring must capture the raw body before JSON parsing — otherwise the hash is always empty and any signed body will fail.
4. Build the canonical byte string and call `verifySignature`, else `401`.
5. Look up `LightningName` by `linkingPubKeyHex` with `active: true`, else `401`.
6. Attach the resolved `User` to `request.user` for downstream handlers.

### Rejection reasons

| Condition | Status | Reason string |
|---|---|---|
| Missing any of the three auth headers | 401 | `Missing auth headers` |
| Timestamp non-numeric or skew > limit | 401 | `Timestamp out of range` |
| Signature verification fails | 401 | `Invalid signature` |
| No active `LightningName` for pubkey | 401 | `Unknown pubkey` |
