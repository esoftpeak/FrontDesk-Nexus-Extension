export type PmsSource = 'synxis' | 'ezee'

/** Reservation context from PMS API (no DOM scraping). */
export type ReservationSnapshot = {
  pms: PmsSource
  confirmationNumber: string | null
  guestName: string | null
  roomNumber: string | null
  stayDatesRaw?: string | null
  addressRaw?: string | null
  checkInDate: string | null
  checkOutDate: string | null
  email: string | null
  phone: string | null
  rateAmount: string | null
  /** Grand total (eZee drawer "Total"; SynXis total when known). */
  reservationTotal: string | null
  /** Amount paid toward stay (eZee drawer "Paid"). */
  amountPaid: string | null
  /** Remaining balance / due (eZee drawer "Balance"). */
  dueAmount: string | null
  restricted: boolean
  loadedAt: string
  pageUrl: string
}

export type ParsedIdFields = {
  fullName: string | null
  dateOfBirth: string | null
  idNumber: string | null
  idType: string | null
  issueDate: string | null
  expiryDate: string | null
  address: string | null
}

/** Fields from SynXis reservation-summary JSON for UI + one spec console line. */
export type SynxisAddressLine = {
  country: string
  city: string
  postalCode: string
  type: string
}

export type SynxisGuestDisplay = {
  /** e.g. "Gaytan, Gloria" */
  nameLine: string
  membershipId: string | null
  addresses: SynxisAddressLine[]
  email: string | null
  phone: string | null
  pmsConfirmationCode: string | null
  /** e.g. "Sun, Apr 05 - Sun, Apr 12 (7 nights)" */
  staySummary: string | null
}

/** eZee Arrivals drawer (DOM scrape) — side panel display. */
export type EzeeGuestDisplay = {
  nameLine: string | null
  /** Country / region line under the name (e.g. United States of America). */
  addressLine: string | null
  reservationNumber: string
  status: string | null
  roomNumber: string | null
  email: string | null
  phone: string | null
  staySummary: string | null
  total: string | null
  paid: string | null
  balance: string | null
}
