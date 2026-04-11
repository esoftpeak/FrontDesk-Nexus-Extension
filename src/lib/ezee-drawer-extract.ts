import type { EzeeGuestDisplay, ReservationSnapshot } from '../shared/pms-types'

/** Raw scrape before normalization (for debugging / future selectors). */
export type EzeeScrapeFields = {
  guestName: string | null
  reservationNumber: string | null
  status: string | null
  roomNumber: string | null
  arrivalDateRaw: string | null
  departureDateRaw: string | null
  email: string | null
  phone: string | null
  country: string | null
  addressLine: string | null
  roomType: string | null
  avgDailyRate: string | null
  total: string | null
  paid: string | null
  balance: string | null
}

function normKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[:.]+$/, '')
    .trim()
}

function normMoney(s: string | null | undefined): string | null {
  if (s == null) return null
  const t = s.replace(/\s+/g, ' ').trim()
  if (!t) return null
  const m = t.match(/\$?\s*([\d,]+\.?\d*)/)
  return m?.[1] ? `$${m[1]}` : t
}

/** eZee Arrivals drawer uses MM-DD-YYYY with optional time — store YYYY-MM-DD for DB. */
export function parseEzeeDateTimeToIsoDate(raw: string | null): string | null {
  if (!raw) return null
  const m = raw.match(/(\d{2})-(\d{2})-(\d{4})/)
  if (!m) return null
  const [, mm, dd, yyyy] = m
  return `${yyyy}-${mm}-${dd}`
}

function pickFromMap(map: Map<string, string>, ...keys: string[]): string | null {
  for (const k of keys) {
    const nk = normKey(k)
    for (const [mk, v] of map) {
      if (normKey(mk).includes(nk) || nk.includes(normKey(mk))) {
        const t = v.trim()
        if (t) return t
      }
    }
  }
  return null
}

/**
 * Collects label → value from Ant Design descriptions and simple two-column rows.
 */
export function collectEzeeLabelValuePairs(root: Element): Map<string, string> {
  const map = new Map<string, string>()

  for (const labelEl of root.querySelectorAll('.ant-descriptions-item-label')) {
    const rawLabel = (labelEl.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!rawLabel) continue
    let content: string | null = null
    const item = labelEl.closest('.ant-descriptions-item')
    if (item) {
      const c = item.querySelector('.ant-descriptions-item-content')
      content = c?.textContent ?? null
    }
    if (content == null) {
      let sib: Element | null = labelEl.nextElementSibling
      while (sib) {
        if (sib.classList.contains('ant-descriptions-item-content')) {
          content = sib.textContent
          break
        }
        sib = sib.nextElementSibling
      }
    }
    if (content != null) {
      const v = content.replace(/\s+/g, ' ').trim()
      if (v) map.set(normKey(rawLabel), v)
    }
  }

  for (const row of root.querySelectorAll('.ant-row')) {
    const cols = row.querySelectorAll('.ant-col')
    if (cols.length < 2) continue
    const label = (cols[0].textContent ?? '').replace(/\s+/g, ' ').trim()
    const value = (cols[cols.length - 1].textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!label || !value) continue
    if (label.length > 64) continue
    if (!/[a-zA-Z]/.test(label)) continue
    map.set(normKey(label), value)
  }

  return map
}

/** Status badges and buttons often use <strong> / typography — do not use as guest name. */
const GRID_START_RE = /^Reservation\s+Number\b/i

function isLikelyCountryOnlyLine(line: string): boolean {
  const t = line.trim()
  return (
    /^United States(?: of America)?$/i.test(t) ||
    /^(United Kingdom|Canada|Mexico|Australia|India|New Zealand|Ireland)$/i.test(t)
  )
}

function looksLikeGuestNameLine(line: string): boolean {
  const t = line.trim()
  if (t.length < 2 || t.length > 120) return false
  if (isLikelyCountryOnlyLine(t)) return false
  if (GRID_START_RE.test(t)) return false
  if (/^(Edit|More|Print|Status|Arrival|Departure|Booking|Room|Rate|Pax|Avg\.|Total|Paid|Balance)\b/i.test(t))
    return false
  if (/^Confirmed\s+Reservation/i.test(t)) return false
  if (/^\$|^\d+\.\d{2}$/.test(t)) return false
  if (/\S+@\S+\.\S+/.test(t)) return false
  if (/^\d{10,}$/.test(t.replace(/\s/g, ''))) return false
  if (/^(Mr\.|Mrs\.|Ms\.|Miss|Dr\.|Prof\.)\s+/i.test(t)) return true
  if (
    /^(?:Mr\.|Mrs\.|Ms\.|Miss|Dr\.|Prof\.\s+)?[A-Za-z][a-zA-Z'’-]*(\s+[A-Za-z][a-zA-Z'’-]*){1,6}$/i.test(t)
  )
    return true
  return false
}

/**
 * Guest name is the first line in the drawer that looks like a person (before the details grid).
 * Avoids mistaken identity with Status badges (green "Confirmed Reservation") or first <strong>.
 */
function extractGuestNameFromEzeeText(fullText: string, body: Element): string | null {
  const lines = fullText
    .split(/\r?\n/)
    .map((l) => l.replace(/\u00a0/g, ' ').trim())
    .filter(Boolean)

  for (const line of lines) {
    if (/^Reservation\s+Number\b/i.test(line)) break
    if (isLikelyCountryOnlyLine(line)) continue
    if (looksLikeGuestNameLine(line)) return line
  }

  for (const h of body.querySelectorAll<HTMLElement>('h1, h2, h3')) {
    const t = (h.innerText ?? h.textContent ?? '').split('\n')[0]?.trim() ?? ''
    if (looksLikeGuestNameLine(t)) return t
  }

  return null
}

/** Country / region line (e.g. "United States of America") — often under the name, before phone/email. */
function extractCountryAddressLine(fullText: string): string | null {
  const lineMatch = fullText
    .split(/\r?\n/)
    .map((l) => l.replace(/\u00a0/g, ' ').trim())
    .find((l) => {
      if (l.length < 3 || l.length > 120) return false
      if (/\S+@\S+\.\S+/.test(l)) return false
      if (/^\d[\d\s().-]{8,}$/.test(l)) return false
      return /United States(?: of America)?|Canada|Mexico|United Kingdom|Australia|India\b/i.test(l)
    })
  return lineMatch ?? null
}

function extractFirstEmailFromText(fullText: string): string | null {
  const m = fullText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/)
  return m?.[0] ?? null
}

/** Prefer 10-digit US-style guest phone; ignore reservation IDs. */
function extractGuestPhoneFromText(fullText: string): string | null {
  const noEmails = fullText.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, ' ')
  const m = noEmails.match(/\b(\d{10})\b/)
  if (m?.[1]) return m[1]
  const m2 = noEmails.match(/\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})\b/)
  if (m2?.[1]) return m2[1].replace(/\D/g, '')
  return null
}

/**
 * eZee stacks "Reservation Number" on one line and "2824" on the next — regex on flat text often misses.
 */
function extractReservationNumberFromEzeeText(fullText: string): string | null {
  const lines = fullText
    .split(/\r?\n/)
    .map((l) => l.replace(/\u00a0/g, ' ').trim())
    .filter(Boolean)

  for (let i = 0; i < lines.length - 1; i++) {
    if (/^Reservation\s*Number$/i.test(lines[i])) {
      const next = lines[i + 1].replace(/\s/g, '')
      if (/^\d{3,12}$/.test(next)) return next
    }
  }

  let m = fullText.match(/Reservation\s*Number\s*[:\s]*(\d{3,12})\b/i)
  if (m?.[1]) return m[1].trim()

  m = fullText.match(/Reservation\s*Number\s*\n\s*(\d{3,12})\b/im)
  if (m?.[1]) return m[1].trim()

  m = fullText.match(/Reservation\s*Number\s+(\d{3,12})\b/i)
  if (m?.[1]) return m[1].trim()

  return null
}


function extractFromTextBlob(text: string): Partial<EzeeScrapeFields> {
  const out: Partial<EzeeScrapeFields> = {}

  let   m = text.match(/Reservation\s*Number\s*[:\s]*([^\n\r]+)/i)
  if (m?.[1]) out.reservationNumber = m[1].trim()

  m = text.match(/Booking\s*(?:ID|#|Number)?\s*[:\s]*([^\n\r]+)/i)
  if (m?.[1] && !out.reservationNumber) out.reservationNumber = m[1].trim()

  m = text.match(/Reservation\s*ID\s*[:\s]*([^\n\r]+)/i)
  if (m?.[1] && !out.reservationNumber) out.reservationNumber = m[1].trim()

  m = text.match(/Room\s*Number\s*[:\s]*([^\n\r]+)/i)
  if (m?.[1]) out.roomNumber = m[1].trim()

  m = text.match(/Status\s*[:\s]*([^\n\r]+)/i)
  if (m?.[1]) out.status = m[1].trim()

  m = text.match(/Arrival\s*Date\s*[:\s]*([^\n\r]+)/i)
  if (m?.[1]) out.arrivalDateRaw = m[1].trim()

  m = text.match(/Departure\s*Date\s*[:\s]*([^\n\r]+)/i)
  if (m?.[1]) out.departureDateRaw = m[1].trim()

  m = text.match(/(?:^|\n)\s*Email\s*[:\s]*([^\s@\n]+@[^\s\n]+)/im)
  if (m?.[1]) out.email = m[1].trim()

  m = text.match(/(?:^|\n)\s*Phone\s*[:\s]*([\d\s().+-]{7,})/im)
  if (m?.[1]) out.phone = m[1].replace(/\s+/g, ' ').trim()

  m = text.match(/Country\s*[:\s]*([^\n\r]+)/i)
  if (m?.[1]) out.country = m[1].trim()

  m = text.match(/Avg\.?\s*Daily\s*Rate\s*[:\s]*([^\n\r]+)/i)
  if (m?.[1]) out.avgDailyRate = m[1].trim()

  m = text.match(/Total\s*[:\s]*\$?\s*([\d,.]+)/i)
  if (m?.[1]) out.total = m[1].trim()

  m = text.match(/Paid\s*[:\s]*\$?\s*([\d,.]+)/i)
  if (m?.[1]) out.paid = m[1].trim()

  m = text.match(/Balance\s*[:\s]*\$?\s*([\d,.]+)/i)
  if (m?.[1]) out.balance = m[1].trim()

  return out
}

function mergeFields(
  map: Map<string, string>,
  blob: Partial<EzeeScrapeFields>,
  body: Element,
  fullText: string,
): EzeeScrapeFields {
  const rLine = extractReservationNumberFromEzeeText(fullText)
  const rMap = pickFromMap(map, 'reservation number', 'reservation no', 'reservation #')
  const r = (rLine ?? rMap ?? blob.reservationNumber ?? '').trim() || null

  const room = pickFromMap(map, 'room number', 'room no', 'room #')
  const status = pickFromMap(map, 'status', 'reservation status')
  const arr = pickFromMap(map, 'arrival date', 'check in', 'check-in')
  const dep = pickFromMap(map, 'departure date', 'check out', 'check-out')
  const emailMap = pickFromMap(map, 'email', 'e-mail')
  const phoneMap = pickFromMap(map, 'phone', 'mobile', 'tel')
  const country = pickFromMap(map, 'country')
  const adr = pickFromMap(map, 'address', 'street')
  const rt = pickFromMap(map, 'room type')
  const adrRate = pickFromMap(map, 'avg daily rate', 'average daily rate', 'adr')

  let total = pickFromMap(map, 'total')
  let paid = pickFromMap(map, 'paid')
  let balance = pickFromMap(map, 'balance', 'due', 'amount due')

  total = normMoney(total ?? blob.total) ?? blob.total ?? null
  paid = normMoney(paid ?? blob.paid) ?? blob.paid ?? null
  balance = normMoney(balance ?? blob.balance) ?? blob.balance ?? null

  const guestName = extractGuestNameFromEzeeText(fullText, body)

  const addressLine =
    extractCountryAddressLine(fullText) ||
    (adr ?? '').trim() ||
    (country ?? '').trim() ||
    null
  const email = (extractFirstEmailFromText(fullText) ?? emailMap ?? blob.email ?? '').trim() || null
  const phone =
    (extractGuestPhoneFromText(fullText) ?? phoneMap ?? blob.phone ?? '').trim() || null

  return {
    guestName: guestName ?? null,
    reservationNumber: r,
    status: (status ?? blob.status ?? '').trim() || null,
    roomNumber: (room ?? blob.roomNumber ?? '').trim() || null,
    arrivalDateRaw: (arr ?? blob.arrivalDateRaw ?? '').trim() || null,
    departureDateRaw: (dep ?? blob.departureDateRaw ?? '').trim() || null,
    email: email || null,
    phone: phone || null,
    country: (country ?? '').trim() || null,
    addressLine: addressLine || null,
    roomType: (rt ?? '').trim() || null,
    avgDailyRate: normMoney(adrRate ?? blob.avgDailyRate) ?? blob.avgDailyRate ?? null,
    total,
    paid,
    balance,
  }
}

const RESERVATION_NUM = /^[A-Z0-9][A-Z0-9-]{2,31}$/i

export function isValidEzeeReservationNumber(s: string | null | undefined): boolean {
  if (!s) return false
  const t = s.trim()
  if (t.length < 3 || t.length > 32) return false
  return RESERVATION_NUM.test(t)
}

/** Pulls a clean reservation # when the label value includes badges or extra words. */
export function normalizeEzeeReservationNumber(raw: string | null | undefined): string | null {
  if (!raw) return null
  const compact = raw.replace(/\s+/g, ' ').trim()
  for (const part of compact.split(/[\s|/,;:]+/)) {
    const t = part.trim()
    if (isValidEzeeReservationNumber(t)) return t
  }
  const m = compact.match(/\b([A-Z0-9][A-Z0-9-]{2,31})\b/i)
  if (m?.[1] && isValidEzeeReservationNumber(m[1])) return m[1]
  return null
}

/**
 * Ant Design drawer: class may be on wrapper or split across nodes; some builds use css-in-js.
 */
export function findOpenEzeeDrawerRoot(doc: Document): HTMLElement | null {
  const direct =
    doc.querySelector<HTMLElement>('.ant-drawer.ant-drawer-open') ??
    doc.querySelector<HTMLElement>('.ant-drawer-open')
  if (direct) return direct

  for (const el of doc.querySelectorAll<HTMLElement>('[class*="ant-drawer"]')) {
    const cls = typeof el.className === 'string' ? el.className : String(el.className ?? '')
    if (cls.includes('ant-drawer-open') || (cls.includes('ant-drawer') && /\bopen\b/.test(cls))) {
      return el
    }
  }
  return null
}

export function findEzeeDrawerBody(openRoot: HTMLElement): HTMLElement | null {
  let body = openRoot.querySelector<HTMLElement>('.ant-drawer-body')
  if (body) return body
  body = openRoot.querySelector<HTMLElement>('.ant-drawer-wrapper-body')
  if (body) return body
  body = openRoot.querySelector<HTMLElement>('[class*="drawer-body"], [class*="DrawerBody"]')
  return body
}

export function isEzeeGuestDrawerOpen(doc: Document): boolean {
  return findOpenEzeeDrawerRoot(doc) != null
}

/** DevTools-friendly snapshot when debugging selectors / timing. */
export type EzeeDrawerProbe = {
  drawerRootFound: boolean
  drawerRootClass: string | null
  bodyFound: boolean
  bodyTextLength: number
  bodyPreview: string
  labelPairCount: number
  mergedReservationRaw: string | null
  normalizedReservation: string | null
  failStage: 'no_drawer' | 'no_body' | 'body_too_small' | 'bad_reservation' | 'ok'
}

export function probeEzeeDrawer(doc: Document): EzeeDrawerProbe {
  const root = findOpenEzeeDrawerRoot(doc)
  if (!root) {
    return {
      drawerRootFound: false,
      drawerRootClass: null,
      bodyFound: false,
      bodyTextLength: 0,
      bodyPreview: '',
      labelPairCount: 0,
      mergedReservationRaw: null,
      normalizedReservation: null,
      failStage: 'no_drawer',
    }
  }

  const body = findEzeeDrawerBody(root)
  const drawerRootClass =
    typeof root.className === 'string' ? root.className.slice(0, 200) : String(root.className ?? '')

  if (!body) {
    return {
      drawerRootFound: true,
      drawerRootClass,
      bodyFound: false,
      bodyTextLength: 0,
      bodyPreview: (root.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      labelPairCount: 0,
      mergedReservationRaw: null,
      normalizedReservation: null,
      failStage: 'no_body',
    }
  }

  const fullText = (body.innerText ?? body.textContent ?? '').replace(/\u00a0/g, ' ')
  const minLen = 24
  if (fullText.length < minLen) {
    return {
      drawerRootFound: true,
      drawerRootClass,
      bodyFound: true,
      bodyTextLength: fullText.length,
      bodyPreview: fullText.slice(0, 200),
      labelPairCount: 0,
      mergedReservationRaw: null,
      normalizedReservation: null,
      failStage: 'body_too_small',
    }
  }

  const map = collectEzeeLabelValuePairs(body)
  const blob = extractFromTextBlob(fullText)
  const merged = mergeFields(map, blob, body, fullText)
  const norm = normalizeEzeeReservationNumber(merged.reservationNumber)

  if (!norm) {
    return {
      drawerRootFound: true,
      drawerRootClass,
      bodyFound: true,
      bodyTextLength: fullText.length,
      bodyPreview: fullText.slice(0, 200),
      labelPairCount: map.size,
      mergedReservationRaw: merged.reservationNumber,
      normalizedReservation: null,
      failStage: 'bad_reservation',
    }
  }

  return {
    drawerRootFound: true,
    drawerRootClass,
    bodyFound: true,
    bodyTextLength: fullText.length,
    bodyPreview: fullText.slice(0, 200),
    labelPairCount: map.size,
    mergedReservationRaw: merged.reservationNumber,
    normalizedReservation: norm,
    failStage: 'ok',
  }
}

export function extractEzeeScrapeFields(doc: Document): EzeeScrapeFields | null {
  const open = findOpenEzeeDrawerRoot(doc)
  if (!open) return null

  const body = findEzeeDrawerBody(open)
  if (!body) return null

  const fullText = (body.innerText ?? body.textContent ?? '').replace(/\u00a0/g, ' ')
  if (fullText.length < 24) return null

  const map = collectEzeeLabelValuePairs(body)
  const blob = extractFromTextBlob(fullText)
  const merged = mergeFields(map, blob, body, fullText)
  const normRes = normalizeEzeeReservationNumber(merged.reservationNumber)
  if (!normRes) return null

  return { ...merged, reservationNumber: normRes }
}

export function ezeeScrapeToSnapshot(
  fields: EzeeScrapeFields,
  pageUrl: string,
  loadedAt: string,
): ReservationSnapshot {
  const conf = fields.reservationNumber!.trim()
  const addrParts = [...new Set([fields.addressLine, fields.country].filter(Boolean))].join(', ')
  const stayDatesRaw =
    fields.arrivalDateRaw && fields.departureDateRaw
      ? `${fields.arrivalDateRaw} → ${fields.departureDateRaw}`
      : null

  return {
    pms: 'ezee',
    confirmationNumber: conf,
    guestName: fields.guestName,
    roomNumber: fields.roomNumber,
    stayDatesRaw,
    addressRaw: addrParts.length > 0 ? addrParts : null,
    checkInDate: parseEzeeDateTimeToIsoDate(fields.arrivalDateRaw),
    checkOutDate: parseEzeeDateTimeToIsoDate(fields.departureDateRaw),
    email: fields.email,
    phone: fields.phone,
    rateAmount: fields.avgDailyRate,
    reservationTotal: fields.total,
    amountPaid: fields.paid,
    dueAmount: fields.balance,
    restricted: false,
    loadedAt,
    pageUrl,
  }
}

export function ezeeScrapeToGuestDisplay(fields: EzeeScrapeFields): EzeeGuestDisplay {
  const arr = fields.arrivalDateRaw ?? ''
  const dep = fields.departureDateRaw ?? ''
  const staySummary = arr && dep ? `${arr} → ${dep}` : arr || dep || null

  return {
    nameLine: fields.guestName,
    addressLine: fields.addressLine,
    reservationNumber: fields.reservationNumber!,
    status: fields.status,
    roomNumber: fields.roomNumber,
    email: fields.email,
    phone: fields.phone,
    staySummary,
    total: fields.total,
    paid: fields.paid,
    balance: fields.balance,
  }
}
