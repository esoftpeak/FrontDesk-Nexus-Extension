/**
 * Runs on https://sph.synxis.com/* (guest stay UI). Control Center keeps the same URL while swapping
 * SPA views; we detect "Guest Stay Record" in this frame, debounce DOM churn, then ask the service
 * worker to load the reservation API + Supabase (same path as manual Get Guest Data, no toast).
 *
 * Also handles FDN_FILL_GUEST_FORM — runs inside SphContentIframe where Guest Details inputs live.
 */
import {
  extractConfirmationFromDocument,
  extractRoomHintFromDocument,
  isLikelyGuestStayRecordView,
} from '../lib/synxis-confirmation-dom'
import { US_STATES_BY_CODE as US_STATES } from '../lib/us-states'

// ── Guest Details auto-fill (runs inside sph.synxis.com iframe) ───────────────

type FillPayload = {
  first_name: string | null
  last_name: string | null
  middle_name: string | null
  phone: string | null
  email: string | null
  address: string | null
  postal_code: string | null
  city: string | null
  state: string | null
  [key: string]: string | null | undefined
}

let _synxisFillInProgress = false
const sphSleep = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms))

function synxisSet(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.blur()
}

function isGuestDetailsModalOpen(): boolean {
  const el = document.getElementById('guest-first-name') as HTMLInputElement | null
    ?? document.querySelector<HTMLInputElement>('input.spark-input__field')
  if (!el) return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function findSynxisInput(labelSubstr: string): HTMLInputElement | null {
  for (const span of Array.from(document.querySelectorAll<HTMLElement>('span.spark-label, label span'))) {
    if ((span.textContent?.trim() ?? '').toLowerCase().includes(labelSubstr.toLowerCase())) {
      const lbl = span.closest('label')
      if (!lbl) continue
      const forId = lbl.getAttribute('for')
      if (forId) {
        const el = document.getElementById(forId) as HTMLInputElement | null
        if (el) return el
      }
      const el = lbl.querySelector<HTMLInputElement>('input, textarea')
      if (el) return el
    }
  }
  return null
}

function findSynxisSelect(labelSubstr: string): HTMLSelectElement | null {
  for (const lbl of Array.from(document.querySelectorAll('label'))) {
    if (lbl.textContent?.toLowerCase().includes(labelSubstr.toLowerCase())) {
      const forAttr = lbl.getAttribute('for')
      if (forAttr) {
        const sel = document.querySelector<HTMLSelectElement>(`select#${forAttr}`)
        if (sel) return sel
      }
      const parent = lbl.parentElement
      if (parent) {
        const sel = parent.querySelector<HTMLSelectElement>('select')
        if (sel) return sel
      }
    }
  }
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (el.children.length === 0 &&
        el.textContent?.trim().toLowerCase().includes(labelSubstr.toLowerCase())) {
      const parent = el.closest('td, tr, div, li')
      if (parent) {
        const sel = parent.querySelector<HTMLSelectElement>('select') ??
                    parent.nextElementSibling?.querySelector<HTMLSelectElement>('select')
        if (sel) return sel
      }
    }
  }
  return null
}

function fillSynxisSelect(labelSubstr: string, value: string): boolean {
  if (!value) return false
  const sel = findSynxisSelect(labelSubstr)
  if (!sel) { console.warn('[FDN SPH] select not found:', labelSubstr); return false }
  const needle = value.toLowerCase()
  const match = Array.from(sel.options).find(
    o => o.text.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle)
  )
  if (!match) {
    console.warn('[FDN SPH] no option match for', labelSubstr, value,
      'available:', Array.from(sel.options).map(o => o.text))
    return false
  }
  sel.value = match.value
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  console.log('[FDN SPH] select filled:', labelSubstr, '→', match.text)
  return true
}

function normalizePhone(phone: string): string {
  const raw = phone.replace(/\D/g, '')
  return (raw.length === 11 && raw.startsWith('1')) ? raw.slice(1) : raw
}

async function fillSynxisGuestForm(data: FillPayload): Promise<void> {
  if (_synxisFillInProgress) { console.log('[FDN SPH] fill already in progress'); return }
  _synxisFillInProgress = true
  console.log('[FDN SPH] fill started', data)

  await sphSleep(400)

  const textFields: Array<[string, string | null | undefined, HTMLInputElement | null]> = [
    ['First Name',     data.first_name,   document.getElementById('guest-first-name') as HTMLInputElement | null],
    ['Last Name',      data.last_name,    document.getElementById('guest-last-name')  as HTMLInputElement | null],
    ['Middle Initial', data.middle_name ? data.middle_name.charAt(0) : null, findSynxisInput('Middle')],
    ['Mobile Phone',   data.phone ? normalizePhone(data.phone) : null,       findSynxisInput('Mobile Phone')],
    ['Primary Email',  data.email,        findSynxisInput('Primary Email')],
    ['Primary Address',data.address,      findSynxisInput('Primary Address')],
    ['Zip',            data.postal_code,  findSynxisInput('Zip')],
    ['City',           data.city,         findSynxisInput('City')],
  ]

  for (const [label, value, el] of textFields) {
    if (!value) continue
    if (el) {
      synxisSet(el, value)
      console.log('[FDN SPH] filled:', label, '←', value)
    } else {
      console.warn('[FDN SPH] input not found:', label)
    }
    await sphSleep(80)
  }

  const stateCode = (data.state ?? '').toUpperCase().trim()
  const stateName = US_STATES[stateCode] ?? data.state ?? ''
  if (stateName) {
    fillSynxisSelect('State', stateName)
    await sphSleep(200)
  }

  fillSynxisSelect('Country', 'United States')

  _synxisFillInProgress = false
  console.log('[FDN SPH] fill complete ✓')
}

function triggerSynxisFill(payload: FillPayload | null): void {
  console.log('[FDN SPH] triggerFill called', { hasPayload: !!payload, isModalOpen: isGuestDetailsModalOpen() })
  void (async () => {
    if (!payload) { console.warn('[FDN SPH] triggerFill: no payload'); return }

    _synxisFillInProgress = false

    if (isGuestDetailsModalOpen()) {
      await fillSynxisGuestForm(payload)
      return
    }

    console.log('[FDN SPH] modal not detected yet, waiting...')
    const obs = new MutationObserver(() => {
      if (isGuestDetailsModalOpen() && !_synxisFillInProgress) {
        obs.disconnect()
        window.clearTimeout(timeout)
        window.setTimeout(() => void fillSynxisGuestForm(payload), 400)
      }
    })
    obs.observe(document.body, { childList: true, subtree: true })
    const timeout = window.setTimeout(() => {
      obs.disconnect()
      console.warn('[FDN SPH] triggerFill: timed out waiting for Guest Details modal')
    }, 30_000)
  })()
}

const sphModalObserver = new MutationObserver(() => {
  if (_synxisFillInProgress && !isGuestDetailsModalOpen()) {
    _synxisFillInProgress = false
  }
})
sphModalObserver.observe(document.body, { childList: true, subtree: true })

function fillSynxisReservationSearch(lastName: string): { ok: boolean; error?: string } {
  const el = document.getElementById('find-reservation-input') as HTMLInputElement | null
  if (!el) {
    return { ok: false, error: 'Search input not found. Make sure the Guest Board is open.' }
  }
  el.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(el, lastName)
  else el.value = lastName
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
  el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
  console.log('[FDN SPH] Find Guest: filled search with', lastName)
  return { ok: true }
}

chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; payload?: FillPayload; lastName?: string },
    _sender,
    sendResponse: (r: { ok: boolean; error?: string }) => void,
  ) => {
    if (message?.type === 'FDN_FILL_GUEST_FORM') {
      console.log('[FDN SPH] FDN_FILL_GUEST_FORM received')
      triggerSynxisFill(message.payload ?? null)
      sendResponse({ ok: true })
      return
    }
    if (message?.type === 'FDN_FIND_GUEST' && message.lastName) {
      sendResponse(fillSynxisReservationSearch(message.lastName))
      return
    }
  },
)

const DEBOUNCE_MS = 100
/** Skip re-sending the same confirmation while the user stays on the same record. */
const LOCAL_DEDUPE_MS = 45_000
/** Direct DOM checks (ms) so slow SPA paint still triggers within ~5–10s without relying on debounce alone. */
const BACKUP_RUN_AT_MS = [600, 4000, 7500, 10000] as const

let debounceTimer = 0
/** Dedupe key: confirmation + DOM room hint so room moves re-fetch the same guest. */
let lastDedupeKey: string | null = null
let lastSentAt = 0

function scheduleCheck(): void {
  window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    void runDetection()
  }, DEBOUNCE_MS)
}

async function runDetection(): Promise<void> {
  if (!isLikelyGuestStayRecordView(document)) return

  const conf = extractConfirmationFromDocument(document)
  if (!conf) return

  const roomHint = extractRoomHintFromDocument(document) ?? ''
  const dedupeKey = `${conf}|${roomHint}`
  const now = Date.now()
  if (dedupeKey === lastDedupeKey && now - lastSentAt < LOCAL_DEDUPE_MS) return

  const { fdn_synxis_auto_load: auto } = await chrome.storage.local.get('fdn_synxis_auto_load')
  if (auto === false) return

  try {
    await chrome.runtime.sendMessage({
      type: 'SYNXIS_AUTO_GUEST_DETECTED',
      confirmation: conf,
      roomHint: roomHint.length > 0 ? roomHint : undefined,
    })
    lastDedupeKey = dedupeKey
    lastSentAt = now
  } catch (e) {
    console.warn('[FDN] SynXis auto-load: sendMessage failed', e)
  }
}

// ── Print Basic Registration Card click (capture phase pierces stopPropagation) ──
document.addEventListener(
  'click',
  (event) => {
    const el = event.target as HTMLElement
    if (el.tagName === 'LI' && el.textContent?.trim() === 'Print Basic Registration Card') {
      const confirmation = extractConfirmationFromDocument(document)
      console.log('[FDN SPH] Print Basic Registration Card clicked | confirmation:', confirmation)
      if (!confirmation) { console.warn('[FDN SPH] No confirmation number found, aborting PDF fetch'); return }
      void (async () => {
        try {
          console.log('[FDN SPH] Fetching registration card PDF...')
          const res = await fetch(
            'https://sph.synxis.com/pms-web-ui/service/v1/guest-mgt/guest-stay-record/registration-card',
            {
              method: 'POST',
              credentials: 'include', // sends session cookies automatically (same origin)
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ payload: { crsConfirmationNumber: confirmation } }),
            },
          )
          if (!res.ok) { console.error('[FDN SPH] PDF fetch failed:', res.status, res.statusText); return }
          const data = await res.json() as { reportData?: string; status?: string; successful?: boolean }
          if (!data.reportData) { console.error('[FDN SPH] No reportData in response'); return }
          console.log('[FDN SPH] Registration card PDF received, storing and opening viewer...')

          // Store PDF + confirmation in extension storage, then open the extension page
          await chrome.storage.local.set({ regCardData: { pdfBase64: data.reportData, confirmation } })
          const pageUrl = chrome.runtime.getURL('registration-card.html')
          // Open directly on the second (right) monitor: left = primary screen width
          // const sw = window.screen.width
          // const sh = window.screen.availHeight
          window.open(pageUrl, '_blank', `popup,left=3200,top=500,width=600,height=900`)
        } catch (err) {
          console.error('[FDN SPH] PDF fetch error:', err)
        }
      })()
    }
  },
  true, // capture phase — fires before any component stopPropagation
)

const observer = new MutationObserver(() => scheduleCheck())
observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true,
})
scheduleCheck()
for (const ms of BACKUP_RUN_AT_MS) {
  window.setTimeout(() => void runDetection(), ms)
}

