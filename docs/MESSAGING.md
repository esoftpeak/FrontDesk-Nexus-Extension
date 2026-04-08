# FrontDesk Nexus — Extension messaging protocol

Messages use `chrome.runtime.sendMessage` unless noted. Payloads are JSON-serializable.

## Content script → Service worker

| `type`        | Body                         | Response |
|---------------|------------------------------|----------|
| `PMS_SCRAPE`  | `{ type, payload: ScrapedReservation }` (sent automatically on interval when the DOM changes) | `{ ok, state? }` |

## Side panel → Service worker

| `type`               | Body | Response |
|----------------------|------|----------|
| `GET_STATE`          | —    | `{ ok, state: ExtensionState }` |
| `AUTH_DEV_LOGIN`     | `{ email, password }` | `{ ok, state? \| error }` |
| `AUTH_LOGOUT`        | —    | `{ ok, state }` |
| `BRIDGE_SET_SESSION` | `{ accessToken, refreshToken, expiresAt? }` | `{ ok, state? \| error }` |
| `SET_SIMULATION`     | `{ enabled: boolean }` | `{ ok, state }` |
| `SCAN_ID_START`      | —    | `{ ok, images?, parsed? \| error }` |
| `SAVE_ID_SCAN`       | `{ parsed, phone, email, manualEntry, managerOverride, imageFrontBase64, imageBackBase64 }` | `{ ok, state? \| error }` |
| `VERIFY_MANAGER`     | `{ email, password }` | `{ ok \| error }` |
| `INJECT_PMS`         | `{ fields: Record<string,string> }` | `{ ok, inject?, error }` |

### `ScrapedReservation` (summary)

- `pms`: `"synxis"` \| `"ezee"`
- `confirmationNumber`, `guestName`, `roomNumber`, dates, `email`, `phone`, amounts, `restricted`, `scrapedAt`, `pageUrl`

### Native Messaging (`com.frontdesk_nexus.native_host`)

**Outbound**

```json
{ "cmd": "scan_id", "correlation_id": "<uuid>" }
```

```json
{ "cmd": "heartbeat" }
```

**Inbound (success)**

```json
{
  "ok": true,
  "correlation_id": "<uuid>",
  "result": {
    "front_image_base64": "<base64>",
    "back_image_base64": "<base64>"
  }
}
```

**Inbound (failure)**

```json
{ "ok": false, "correlation_id": "<uuid>", "error": "message" }
```

## Service worker → Content script

| `type`       | Purpose |
|--------------|---------|
| `FDN_INJECT` | `{ type, fields }` — fill PMS form fields; response `{ ok, applied?, error? }` |
| `FDN_REQUEST_SCRAPE` | Force re-scrape |

## Session bridge (Web Portal)

Production auth should call `BRIDGE_SET_SESSION` with Supabase `access_token` and `refresh_token` after portal login.

To signal logout from the portal, set storage key `fdn_bridge_revoked` (e.g. bump a counter) in `chrome.storage.local`; the service worker signs out when this changes.
