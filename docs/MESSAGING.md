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
| `SAVE_ID_SCAN`            | `{ parsed, phone, email, manualEntry, managerOverride, imageFrontBase64, imageBackBase64, ocrProvider? }` | `{ ok, state? \| error }` — DNR gate, storage, `id_scans`, `audit_log` (no PMS inject here) |
| `VERIFY_MANAGER`          | `{ email, password }` | `{ ok \| error }` |
| `INJECT_PMS`              | `{ fields: Record<string,string> }` | `{ ok, inject?, error }` |

## Service worker → Side panel (push)

| `type` | Body |
|--------|------|
| `FDN_NATIVE_ID_SCAN` | `{ parsed, images, imageBase64Length, ocrProvider, autoSave }` — Thales/SDK host sent `SCAN_RESULT` over native messaging; worker may have auto-saved (see `autoSave`). Also stored under `chrome.storage.local` key `fdn_last_native_scan`. |

## ID scan & save lifecycle

1. **Service worker** starts **`connectNative('com.frontdesk.nexus')`** and sends **`{ type: 'SCAN_ID' }`** once per connection (handshake / ready).
2. **Python host** (Thales SDK): when a scan completes, sends **`SCAN_RESULT`** (or **`ERROR`**) over stdout framing.
3. **Service worker** maps fields, attempts **automatic** `id_scans` save (same rules as manual save: signed in, reservation context, DNR, etc.).
4. **Side panel** receives **`FDN_NATIVE_ID_SCAN`** and shows fields + preview; notice reflects save outcome.
5. **Manual** **`SAVE_ID_SCAN`** remains for edits, guest phone/email, manager override, or retry after a failed auto-save.
6. **PMS**: **`INJECT_PMS`** — separate from native messaging.

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

### Native Messaging (`com.frontdesk.nexus`)

Registry + host manifest `name` must match `NATIVE_HOST_NAME` in `src/shared/protocol.ts`. Host manifest `allowed_origins` must include your extension origin, e.g. `chrome-extension://<extension-id>/`.

**Chrome → Python (scan)**

```json
{ "type": "SCAN_ID" }
```

**Python → Chrome (success)** — ID strings use the **same camelCase keys** as the side panel (`fullName`, `dateOfBirth`, `idNumber`, `idType`, `issueDate`, `expiryDate`, `address`). Put them in `ocr_data` and/or on the object root (root wins if both set). Chrome still delivers a deserialized object; the extension only **trims** strings and fills nulls — **no OCR or rename** in the extension.

```json
{
  "type": "SCAN_RESULT",
  "success": true,
  "image_base64": "<base64>",
  "ocr_data": {
    "fullName": "",
    "dateOfBirth": "",
    "idNumber": "",
    "idType": "",
    "issueDate": "",
    "expiryDate": "",
    "address": ""
  }
}
```

**Python → Chrome (error)**

```json
{ "type": "ERROR", "message": "…" }
```

Launch: `python.exe path/to/main.py --native-messaging`

## Service worker → Content script

| `type`       | Purpose |
|--------------|---------|
| `FDN_INJECT` | `{ type, fields }` — fill PMS form fields; response `{ ok, applied?, error? }` |
| `EZEE_EXTRACT_NOW` | eZee autoload script only — returns `{ ok, snapshot?, guestDisplay?, error? }` for manual refresh |

## Session bridge (Web Portal)

Production auth should call `BRIDGE_SET_SESSION` with Supabase `access_token` and `refresh_token` after portal login.

To signal logout from the portal, set storage key `fdn_bridge_revoked` (e.g. bump a counter) in `chrome.storage.local`; the service worker signs out when this changes.
