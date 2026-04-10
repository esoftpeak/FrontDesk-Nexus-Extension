# FrontDesk Nexus — Extension messaging protocol

Messages use `chrome.runtime.sendMessage` unless noted. Payloads are JSON-serializable.

## Side panel → Service worker

| `type`                    | Body | Response |
|---------------------------|------|----------|
| `GET_STATE`               | —    | `{ ok, state: ExtensionState }` |
| `LOAD_SYNXIS_RESERVATION` | — (POST body is a fixed sample in the service worker) | `{ ok, state?, message? \| error }` |
| `LOAD_EZEE_RESERVATION`   | —    | `{ ok, state?, message? \| error }` — scrapes open Ant Design guest drawer on `live.ipms247.com` |
| `AUTH_DEV_LOGIN`          | `{ email, password }` | `{ ok, state? \| error }` |
| `AUTH_LOGOUT`             | —    | `{ ok, state }` |
| `BRIDGE_SET_SESSION`      | `{ accessToken, refreshToken, expiresAt? }` | `{ ok, state? \| error }` |
| `SET_SIMULATION`          | `{ enabled: boolean }` | `{ ok, state }` |
| `SCAN_ID_START`           | —    | `{ ok, images?, parsed? \| error }` |
| `SAVE_ID_SCAN`            | `{ parsed, phone, email, manualEntry, managerOverride, imageFrontBase64, imageBackBase64 }` | `{ ok, state? \| error }` |
| `VERIFY_MANAGER`          | `{ email, password }` | `{ ok \| error }` |
| `INJECT_PMS`              | `{ fields: Record<string,string> }` | `{ ok, inject?, error }` |

### `ReservationSnapshot` (extension state `reservation`)

- `pms`: `"synxis"` \| `"ezee"`
- `confirmationNumber`, `guestName`, `roomNumber`, dates, `email`, `phone`, amounts, `restricted`, `loadedAt`, `pageUrl`

Populated for SynXis via `LOAD_SYNXIS_RESERVATION` (API). Populated for eZee via DOM scrape (`LOAD_EZEE_RESERVATION` or auto-detect from the content script).

### Content script → Service worker (auto-load)

| `type` | Body |
|--------|------|
| `SYNXIS_AUTO_GUEST_DETECTED` | `{ confirmation, roomHint? }` |
| `EZEE_AUTO_GUEST_DETECTED` | `{ snapshot: ReservationSnapshot, guestDisplay: EzeeGuestDisplay }` |

### `EzeeGuestDisplay` (extension state `ezeeGuestDisplay`)

Structured fields from the eZee Arrivals drawer scrape. `null` until an eZee load succeeds.

### `SynxisGuestDisplay` (extension state `synxisGuestDisplay`)

Structured fields parsed from the SynXis reservation-summary JSON for the side panel: name line, loyalty `membershipId`, `addresses[]`, `email`, `phone`, `pmsConfirmationCode`, `staySummary`. `null` until a successful load.

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
| `EZEE_EXTRACT_NOW` | eZee autoload script only — returns `{ ok, snapshot?, guestDisplay?, error? }` for manual refresh |

## Session bridge (Web Portal)

Production auth should call `BRIDGE_SET_SESSION` with Supabase `access_token` and `refresh_token` after portal login.

To signal logout from the portal, set storage key `fdn_bridge_revoked` (e.g. bump a counter) in `chrome.storage.local`; the service worker signs out when this changes.
