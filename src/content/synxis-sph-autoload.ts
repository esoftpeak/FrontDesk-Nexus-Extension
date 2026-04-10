/**
 * Runs on https://sph.synxis.com/* (guest stay UI). Control Center keeps the same URL while swapping
 * SPA views; we detect "Guest Stay Record" in this frame, debounce DOM churn, then ask the service
 * worker to load the reservation API + Supabase (same path as manual Get Guest Data, no toast).
 */
import {
  extractConfirmationFromDocument,
  isLikelyGuestStayRecordView,
} from '../lib/synxis-confirmation-dom'

const DEBOUNCE_MS = 100
/** Skip re-sending the same confirmation while the user stays on the same record. */
const LOCAL_DEDUPE_MS = 45_000
/** Direct DOM checks (ms) so slow SPA paint still triggers within ~3–7s without waiting on debounce-only. */
const BACKUP_RUN_AT_MS = [400, 2000, 5500] as const

let debounceTimer = 0
let lastSentConfirmation: string | null = null
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

  const now = Date.now()
  if (conf === lastSentConfirmation && now - lastSentAt < LOCAL_DEDUPE_MS) return

  const { fdn_synxis_auto_load: auto } = await chrome.storage.local.get('fdn_synxis_auto_load')
  if (auto === false) return

  lastSentConfirmation = conf
  lastSentAt = now

  try {
    await chrome.runtime.sendMessage({ type: 'SYNXIS_AUTO_GUEST_DETECTED', confirmation: conf })
  } catch (e) {
    console.warn('[FDN] SynXis auto-load: sendMessage failed', e)
  }
}

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
