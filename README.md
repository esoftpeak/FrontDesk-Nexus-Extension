# FrontDesk Nexus — Chrome extension

Manifest V3 extension: **side panel** UI, **SynXis / eZee** content scripts, **Supabase** (Module 1 ID flow), and **Native Messaging** to the ID scanner Python host (`com.frontdesk.nexus`).

## Prerequisites

- Node 20+
- A Supabase project with your schema (e.g. `reservations`, `id_scans`, `dnr_entries`, `audit_log`, `terminals`, `profiles`) and a private Storage bucket **`id-images`** with policies that allow authenticated uploads.

## Setup

1. Copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
2. `npm install`
3. `npm run build`
4. Chrome → **Extensions** → **Load unpacked** → select the **`dist`** folder.

## Development

- `npm run dev` — Vite + CRXJS dev server (see [CRXJS docs](https://crxjs.dev/vite-plugin)).
- Use **Development login** in the side panel with a Supabase user, or call `BRIDGE_SET_SESSION` from the web portal once the session bridge is wired.

## Side panel & toolbar

The service worker calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` so the **toolbar icon opens the side panel** (Chrome).

## Docs

- [Message protocol](./docs/MESSAGING.md) — content script, side panel, service worker, native host.

## PMS selectors

SynXis and eZee DOM scraping / injection use **placeholder selectors**. Calibrate `src/content/synxis.ts` and `src/content/ezee.ts` against your live PMS pages.

## Native host

Host name: **`com.frontdesk.nexus`** (see `src/shared/protocol.ts` and `src/config/nativeMessaging.ts`). Install the Windows native messaging host separately; the host JSON must list your extension in `allowed_origins` (e.g. `chrome-extension://dhhlencfcfageiedbagdomapcfgbnhmf/` — replace with your ID from `chrome://extensions`).

**Production ID flow:** side panel → service worker → **native messaging only** → your Python host (scanner + OCR + any mock logic **inside Python**) → result back → UI. **DNR** and **DB save** run on **Save**, not on Scan. **PMS inject** is a later step via the content script (`INJECT_PMS`), not via the native host.

If the host is not installed, **Scan ID** will fail until Registry + host JSON + Python are set up; you can still use **manual entry** for ID fields. See [MESSAGING.md](./docs/MESSAGING.md#id-scan--save-lifecycle).

## Tech

- React + TypeScript + Vite
- [@crxjs/vite-plugin](https://github.com/crxjs/chrome-extension-tools)
- [@supabase/supabase-js](https://supabase.com/docs/reference/javascript/introduction)
