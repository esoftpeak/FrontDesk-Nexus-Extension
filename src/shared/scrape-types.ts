export type PmsSource = 'synxis' | 'ezee'

/** Normalized payload from content scripts → service worker */
export type ScrapedReservation = {
  pms: PmsSource
  confirmationNumber: string | null
  guestName: string | null
  roomNumber: string | null
  checkInDate: string | null
  checkOutDate: string | null
  email: string | null
  phone: string | null
  rateAmount: string | null
  reservationTotal: string | null
  /** eZee: due / balance for future Cash module */
  dueAmount: string | null
  /** SynXis restricted flag when detectable */
  restricted: boolean
  scrapedAt: string
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
