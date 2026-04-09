import type { ReservationSnapshot, SynxisAddressLine, SynxisGuestDisplay } from '../shared/pms-types'

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

/** Fallback when JSON shape differs from expected SynXis envelope. */
function deepFindString(input: unknown, keyCandidates: string[]): string | null {
  const wanted = new Set(keyCandidates.map((k) => k.toLowerCase()))
  const stack: unknown[] = [input]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur || typeof cur !== 'object') continue
    if (Array.isArray(cur)) {
      for (const x of cur) stack.push(x)
      continue
    }
    const obj = cur as Record<string, unknown>
    for (const [k, v] of Object.entries(obj)) {
      if (wanted.has(k.toLowerCase()) && typeof v === 'string' && v.trim()) return v.trim()
      if (v && typeof v === 'object') stack.push(v)
    }
  }
  return null
}

function snapshotFromDeepFind(
  json: unknown,
  tabUrl: string,
  confirmationFallback: string,
): ReservationSnapshot {
  return {
    pms: 'synxis',
    confirmationNumber:
      deepFindString(json, ['confirmationNumber', 'confirmationNo', 'confirmation', 'account']) ??
      confirmationFallback,
    guestName: deepFindString(json, ['guestName', 'fullName', 'name']) ?? null,
    roomNumber: deepFindString(json, ['roomNumber', 'roomNo', 'room']) ?? null,
    stayDatesRaw: deepFindString(json, ['stayDates', 'stayDate', 'stay_dates']) ?? null,
    addressRaw: deepFindString(json, ['address', 'addressLine1', 'streetAddress']) ?? null,
    checkInDate:
      deepFindString(json, ['checkInDate', 'checkIn', 'arrivalDate', 'arrival']) ?? null,
    checkOutDate:
      deepFindString(json, ['checkOutDate', 'checkOut', 'departureDate', 'departure']) ?? null,
    email: deepFindString(json, ['email', 'emailAddress']) ?? null,
    phone: deepFindString(json, ['phone', 'phoneNumber', 'mobile']) ?? null,
    rateAmount: deepFindString(json, ['rateAmount', 'rate', 'adr']) ?? null,
    reservationTotal: deepFindString(json, ['reservationTotal', 'total', 'grandTotal']) ?? null,
    dueAmount: deepFindString(json, ['dueAmount', 'balance', 'amountDue']) ?? null,
    restricted: false,
    loadedAt: new Date().toISOString(),
    pageUrl: tabUrl,
  }
}

function formatSynxisStaySummary(stay: Record<string, unknown>): string | null {
  const nights = stay.numberOfNights
  const n = typeof nights === 'number' ? nights : null
  const arrIso = typeof stay.arrivalDateIsoUtc === 'string' ? stay.arrivalDateIsoUtc : null
  const depIso = typeof stay.departureDateIsoUtc === 'string' ? stay.departureDateIsoUtc : null
  if (arrIso && depIso && n != null) {
    const d1 = new Date(arrIso)
    const d2 = new Date(depIso)
    if (!Number.isNaN(d1.getTime()) && !Number.isNaN(d2.getTime())) {
      const fmt = new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        month: 'short',
        day: '2-digit',
      })
      return `${fmt.format(d1)} - ${fmt.format(d2)} (${n} nights)`
    }
  }
  const checkIn = typeof stay.checkInDate === 'string' ? stay.checkInDate : ''
  if (checkIn && n != null) return `${checkIn} (${n} nights)`
  return null
}

const emptyDisplay = (): SynxisGuestDisplay => ({
  nameLine: '—',
  membershipId: null,
  addresses: [],
  email: null,
  phone: null,
  pmsConfirmationCode: null,
  staySummary: null,
})

/** Single service-worker console line for SynXis guest spec (no other logs). */
export function logSynxisGuestSpecConsole(d: SynxisGuestDisplay): void {
  console.log('[FDN][SynXis] guest spec', {
    '1. lastname, firstname': d.nameLine,
    '2. reservationLoyalties.membershipId': d.membershipId,
    '3. addresses': d.addresses,
    '4. email': d.email,
    '5. Phone': d.phone,
    '6. pmsConfirmationCode': d.pmsConfirmationCode,
    '7. checkInDate + numberOfNights': d.staySummary,
  })
}

export function parseSynxisReservationSummaryResponse(
  json: unknown,
  tabUrl: string,
  confirmationFallback: string,
): { snapshot: ReservationSnapshot; display: SynxisGuestDisplay } {
  if (!isRecord(json)) {
    return {
      snapshot: snapshotFromDeepFind(json, tabUrl, confirmationFallback),
      display: emptyDisplay(),
    }
  }

  const res = json.reservation
  if (!isRecord(res)) {
    return {
      snapshot: snapshotFromDeepFind(json, tabUrl, confirmationFallback),
      display: emptyDisplay(),
    }
  }

  const guest = res.guest
  const stay = res.stay
  if (!isRecord(guest)) {
    return {
      snapshot: snapshotFromDeepFind(json, tabUrl, confirmationFallback),
      display: emptyDisplay(),
    }
  }

  const lastName = typeof guest.lastName === 'string' ? guest.lastName : ''
  const firstName = typeof guest.firstName === 'string' ? guest.firstName : ''
  const nameLine =
    [lastName, firstName].filter((x) => x.length > 0).join(', ') || '—'

  let membershipId: string | null = null
  const loyalties = res.reservationLoyalties
  if (Array.isArray(loyalties)) {
    for (const L of loyalties) {
      if (!isRecord(L)) continue
      if (typeof L.membershipId === 'string' && L.membershipId.trim()) {
        membershipId = L.membershipId.trim()
        break
      }
    }
  }

  const addresses: SynxisAddressLine[] = []
  if (Array.isArray(guest.addresses)) {
    for (const a of guest.addresses) {
      if (!isRecord(a)) continue
      addresses.push({
        country: typeof a.country === 'string' ? a.country : '',
        city: typeof a.city === 'string' ? a.city : '',
        postalCode: typeof a.postalCode === 'string' ? a.postalCode : '',
        type: typeof a.type === 'string' ? a.type : '',
      })
    }
  }

  let email: string | null = null
  if (typeof guest.email === 'string' && guest.email.trim()) email = guest.email.trim()
  else if (Array.isArray(guest.emailAddress)) {
    for (const e of guest.emailAddress) {
      if (isRecord(e) && typeof e.value === 'string' && e.value.trim()) {
        email = e.value.trim()
        break
      }
    }
  }

  let phone: string | null = null
  if (typeof guest.phoneNumber === 'string' && guest.phoneNumber.trim()) {
    phone = guest.phoneNumber.trim()
  } else if (Array.isArray(guest.contactNumbers)) {
    for (const c of guest.contactNumbers) {
      if (isRecord(c) && typeof c.number === 'string' && c.number.trim()) {
        phone = c.number.trim()
        break
      }
    }
  }

  const pmsConfirmationCode =
    typeof guest.pmsConfirmationCode === 'string' ? guest.pmsConfirmationCode : null

  const staySummary = isRecord(stay) ? formatSynxisStaySummary(stay) : null

  const display: SynxisGuestDisplay = {
    nameLine,
    membershipId,
    addresses,
    email,
    phone,
    pmsConfirmationCode,
    staySummary,
  }

  const guestName =
    [firstName, lastName].filter((x) => x.length > 0).join(' ') || null

  let roomNumber: string | null = null
  if (isRecord(stay) && typeof stay.room === 'string') roomNumber = stay.room

  let checkInDate: string | null = null
  let checkOutDate: string | null = null
  if (isRecord(stay)) {
    if (typeof stay.checkInDate === 'string') checkInDate = stay.checkInDate
    if (!checkInDate && typeof stay.arrivalDateIsoUtc === 'string') {
      checkInDate = stay.arrivalDateIsoUtc
    }
    if (typeof stay.departureDateIsoUtc === 'string') {
      const d = new Date(stay.departureDateIsoUtc)
      if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1) checkOutDate = stay.departureDateIsoUtc
    }
  }

  let reservationTotal: string | null = null
  const tp = res.totalPrice
  if (isRecord(tp) && typeof tp.totalAmountWithTaxesFees === 'number') {
    reservationTotal = String(tp.totalAmountWithTaxesFees)
  }

  const addressRaw =
    addresses.length > 0
      ? addresses
          .map((a) =>
            [a.city, a.country, a.postalCode].filter((x) => x.length > 0).join(', '),
          )
          .join(' | ')
      : typeof guest.address === 'string'
        ? guest.address
        : null

  const restricted = res.restrictedInPropertyHub === true

  const snapshot: ReservationSnapshot = {
    pms: 'synxis',
    confirmationNumber: pmsConfirmationCode ?? confirmationFallback,
    guestName,
    roomNumber,
    stayDatesRaw: staySummary,
    addressRaw,
    checkInDate,
    checkOutDate,
    email,
    phone,
    rateAmount: null,
    reservationTotal,
    dueAmount: null,
    restricted,
    loadedAt: new Date().toISOString(),
    pageUrl: tabUrl,
  }

  return { snapshot, display }
}
