import type { ScrapedReservation } from '../shared/scrape-types'
import { injectFields, type InjectResult } from './inject-helpers'

const EZEE_INJECT_SELECTORS: Record<string, string[]> = {
  firstName: ['input[name="firstName"]', 'input[id*="FirstName" i]'],
  lastName: ['input[name="lastName"]', 'input[id*="LastName" i]'],
  phone: ['input[name="phone"]', 'input[id*="Phone" i]', 'input[type="tel"]'],
  email: ['input[name="email"]', 'input[type="email"]'],
  address: ['input[name="address"]', 'textarea[name="address"]'],
  city: ['input[name="city"]'],
  state: ['input[name="state"]'],
  postalCode: ['input[name="zip"]', 'input[name="postalCode"]'],
}

function pickInput(selectors: string[]): string | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel) as HTMLInputElement | null
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

function scrapeEzee(): ScrapedReservation {
  const pageUrl = location.href

  const confirmationNumber =
    pickInput(['input[name="confirmation"]', 'input[id*="confirmation" i]']) ??
    pageUrl.match(/(?:reservation|booking|confirm)[=\/-]?([A-Z0-9-]+)/i)?.[1] ??
    null

  return {
    pms: 'ezee',
    confirmationNumber,
    guestName:
      pickInput(['input[id*="GuestName" i]', 'input[name="guestName"]']) ??
      pickTextContent(['.guest-name', '[data-guest-name]']),
    roomNumber:
      pickInput(['input[id*="Room" i]', 'input[name="roomNo"]']) ??
      pickTextContent(['[data-room]']),
    checkInDate: pickInput(['input[id*="CheckIn" i]', 'input[name="checkIn"]']),
    checkOutDate: pickInput(['input[id*="CheckOut" i]', 'input[name="checkOut"]']),
    email: pickInput(['input[type="email"]']),
    phone: pickInput(['input[type="tel"]']),
    rateAmount: pickInput(['input[id*="Rate" i]']),
    reservationTotal: pickInput(['input[id*="Total" i]']),
    dueAmount:
      pickTextContent(['[id*="Due" i]', '[class*="due" i]', '[data-due]']) ??
      pickInput(['input[id*="Due" i]']),
    restricted: !!document.body?.innerText?.match(/restricted|blocked/i),
    scrapedAt: new Date().toISOString(),
    pageUrl,
  }
}

let lastJson = ''

function publishIfChanged() {
  const payload = scrapeEzee()
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
      sendResponse(injectFields(EZEE_INJECT_SELECTORS, message.fields))
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
