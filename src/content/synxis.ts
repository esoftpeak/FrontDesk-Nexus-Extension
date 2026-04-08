import type { ScrapedReservation } from '../shared/scrape-types'
import { injectFields, type InjectResult } from './inject-helpers'

/** Calibrate per property — multiple strategies (spec §19). */
const SYNXIS_INJECT_SELECTORS: Record<string, string[]> = {
  firstName: ['input[name="firstName"]', 'input[id*="firstName" i]', '#firstName'],
  lastName: ['input[name="lastName"]', 'input[id*="lastName" i]', '#lastName'],
  phone: ['input[name="phone"]', 'input[type="tel"]', 'input[id*="phone" i]'],
  email: ['input[name="email"]', 'input[type="email"]', 'input[id*="email" i]'],
  address: ['input[name="address"]', 'textarea[name="address"]', 'input[id*="address" i]'],
  city: ['input[name="city"]', 'input[id*="city" i]'],
  state: ['input[name="state"]', 'input[id*="state" i]'],
  postalCode: ['input[name="postalCode"]', 'input[name="zip"]', 'input[id*="postal" i]'],
}

function pickInput(selectors: string[]): string | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null
    if (el?.value?.trim()) return el.value.trim()
  }
  return null
}

function pickTextContent(selectors: string[]): string | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    const t = el?.textContent?.trim()
    if (t) return t
  }
  return null
}

function scrapeSynxis(): ScrapedReservation {
  const pageUrl = location.href

  const confirmationNumber =
    pickInput([
      'input[name="confirmationNumber"]',
      'input[id*="confirmation" i]',
      '[data-testid*="confirmation" i]',
    ]) ??
    (pageUrl.match(/(?:confirmation|conf)(?:No|Num|irmation)?[=\/-]([A-Z0-9-]+)/i)?.[1] ??
      null)

  const guestName =
    pickInput(['input[name="guestName"]', 'input[id*="guestName" i]']) ??
    pickTextContent(['[data-field="guestName"]', 'h1.guest-name', '.guest-header'])

  const roomNumber =
    pickInput(['input[name="room"]', 'input[id*="room" i]']) ??
    pickTextContent(['[data-field="room"]'])

  return {
    pms: 'synxis',
    confirmationNumber,
    guestName,
    roomNumber,
    checkInDate: pickInput(['input[name="checkIn"]', 'input[id*="checkIn" i]']),
    checkOutDate: pickInput(['input[name="checkOut"]', 'input[id*="checkOut" i]']),
    email: pickInput(['input[type="email"]', 'input[name="email"]']),
    phone: pickInput(['input[type="tel"]', 'input[name="phone"]']),
    rateAmount: pickInput(['input[id*="rate" i]', 'input[name="rate"]']),
    reservationTotal: pickInput(['input[id*="total" i]', 'input[name="total"]']),
    dueAmount: null,
    restricted: !!document.body?.innerText?.match(/restricted reservation/i),
    scrapedAt: new Date().toISOString(),
    pageUrl,
  }
}

let lastJson = ''

function publishIfChanged() {
  const payload = scrapeSynxis()
  const s = JSON.stringify(payload)
  if (s === lastJson) return
  lastJson = s
  void chrome.runtime.sendMessage({ type: 'PMS_SCRAPE', payload })
}

const interval = window.setInterval(publishIfChanged, 2500)
publishIfChanged()

window.addEventListener('beforeunload', () => clearInterval(interval))

chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; fields?: Record<string, string> },
    _sender,
    sendResponse: (r: InjectResult) => void,
  ) => {
    if (message?.type === 'FDN_INJECT' && message.fields) {
      sendResponse(injectFields(SYNXIS_INJECT_SELECTORS, message.fields))
      return
    }
    if (message?.type === 'FDN_REQUEST_SCRAPE') {
      lastJson = ''
      publishIfChanged()
      sendResponse({ ok: true, applied: ['scrape'] } as InjectResult)
      return
    }
  },
)

export {}
