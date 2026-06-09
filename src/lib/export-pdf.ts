import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type PDFImage } from 'pdf-lib'
import type { HotelContact } from '../shared/protocol'
import type { IdScanDetailGuru, ParsedIdFields } from '../shared/pms-types'
import { ageYearsFromDobString } from './id-age'
import { guessImageMimeFromBase64 } from './imageMime'
import { transformBase64ImageSync } from './imageTransform'

// ── Colors ──────────────────────────────────────────────────────────────────
const BLACK  = rgb(0,    0,    0)
const GRAY   = rgb(0.45, 0.45, 0.45)
const LIGHT  = rgb(0.75, 0.75, 0.75)

// ── Page geometry ────────────────────────────────────────────────────────────
const PAGE_W = 612
const PAGE_H = 792
const MARGIN = 50
const COL_W  = PAGE_W - MARGIN * 2

// ── Drawing helpers ──────────────────────────────────────────────────────────

function text(
  page: PDFPage,
  str: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  color = BLACK,
) {
  if (!str?.trim()) return
  page.drawText(str, { x, y, size, font, color })
}

function centeredText(
  page: PDFPage,
  str: string,
  y: number,
  size: number,
  font: PDFFont,
  color = BLACK,
) {
  if (!str?.trim()) return
  const w = font.widthOfTextAtSize(str, size)
  text(page, str, (PAGE_W - w) / 2, y, size, font, color)
}

function hRule(page: PDFPage, y: number, color = LIGHT) {
  page.drawLine({
    start: { x: MARGIN, y },
    end:   { x: PAGE_W - MARGIN, y },
    thickness: 0.5,
    color,
  })
}

/** Underlined section header, returns y after the underline. */
function sectionHeader(
  page: PDFPage,
  label: string,
  y: number,
  bold: PDFFont,
): number {
  const size = 9
  page.drawText(label, { x: MARGIN, y, size, font: bold, color: BLACK })
  const w = bold.widthOfTextAtSize(label, size)
  page.drawLine({
    start:     { x: MARGIN, y: y - 1.5 },
    end:       { x: MARGIN + w, y: y - 1.5 },
    thickness: 0.75,
    color:     BLACK,
  })
  return y - 14
}

/** "Label: Value" field — skips rendering entirely if value is blank. */
function field(
  page: PDFPage,
  label: string,
  value: string | null | undefined,
  y: number,
  regular: PDFFont,
  size = 9,
): number {
  const v = value?.trim()
  if (!v) return y
  page.drawText(`${label}: ${v}`, { x: MARGIN, y, size, font: regular, color: BLACK })
  return y - 13
}

// ── Date helpers ─────────────────────────────────────────────────────────────

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "04-Oct-1977" from any supported date string. */
function formatDobDisplay(dob: string | null | undefined): string {
  if (!dob?.trim()) return ''
  const iso = dob.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) {
    const m = parseInt(iso[2]!, 10) - 1
    return `${String(parseInt(iso[3]!, 10)).padStart(2, '0')}-${MONTH_ABBR[m] ?? ''}-${iso[1]}`
  }
  const us = dob.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (us) {
    const m = parseInt(us[1]!, 10) - 1
    return `${String(parseInt(us[2]!, 10)).padStart(2, '0')}-${MONTH_ABBR[m] ?? ''}-${us[3]}`
  }
  return dob.trim()
}

/** "Jun 05, 2026 03:10 AM" */
function formatCheckInDisplay(iso: string | null | undefined): string {
  if (!iso?.trim()) return new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso!.trim()
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** "05-Jun-2026 6:38 AM" for PDF footer timestamp. */
function formatFooterTimestamp(): string {
  const d = new Date()
  const day = String(d.getDate()).padStart(2, '0')
  const m = MONTH_ABBR[d.getMonth()] ?? ''
  const year = d.getFullYear()
  const time = d.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day}-${m}-${year} ${time}`
}

/** "Jun 08, 2026" from an ISO date or date-time string. */
function formatDateDisplay(iso: string | null | undefined): string {
  if (!iso?.trim()) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso!.trim()
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })
}

/** Normalize raw gender value ("M" → "Male", "F" → "Female", others as-is). */
function normalizeGender(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  const g = raw.trim()
  if (g.toLowerCase() === 'm' || g.toLowerCase() === 'male')   return 'Male'
  if (g.toLowerCase() === 'f' || g.toLowerCase() === 'female') return 'Female'
  return g
}

// ── Guest Profile PDF ─────────────────────────────────────────────────────────

export type GuestProfileInput = {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  phone: string
  email: string
  /** ISO timestamp of scan / check-in (used for "Check-In at" line). */
  scanTime: string | null
  /** Raw document_data from native host (for gender field). */
  documentData: Record<string, unknown> | null
  /** Front scan image base64 (JPEG or PNG). Null = no image. */
  imageFrontBase64: string | null
  /** Current UI rotation (degrees) and flip for the image. */
  rotationDeg: number
  flipH: boolean
  hotel: HotelContact
}

export async function buildGuestProfilePdf(input: GuestProfileInput): Promise<Uint8Array> {
  const { idDetail, parsed, phone, email, scanTime, documentData, hotel } = input

  const pdfDoc = await PDFDocument.create()
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const page    = pdfDoc.addPage([PAGE_W, PAGE_H])

  // ── Guest name ────────────────────────────────────────────────────────────
  const nameParts = [idDetail.firstName, idDetail.middleName, idDetail.lastName]
    .map(p => p?.trim()).filter(Boolean)
  const guestName = nameParts.length > 0
    ? nameParts.join(' ').toUpperCase()
    : (parsed.fullName?.trim().toUpperCase() ?? 'GUEST')

  let y = PAGE_H - MARGIN

  // Name — bold, 16pt, centered
  const nameSize = 16
  const nameW = bold.widthOfTextAtSize(guestName, nameSize)
  text(page, guestName, (PAGE_W - nameW) / 2, y, nameSize, bold)
  y -= 22

  // Check-In line — 10pt, gray, centered
  const checkInStr = `Check-In at ${formatCheckInDisplay(scanTime)}`
  centeredText(page, checkInStr, y, 10, regular, GRAY)
  y -= 18

  hRule(page, y)
  y -= 18

  // ── CONTACT INFORMATION ───────────────────────────────────────────────────
  y = sectionHeader(page, 'CONTACT INFORMATION', y, bold)
  y -= 4

  const address = idDetail.streetAddress?.trim() || parsed.address?.trim()
  y = field(page, 'Address', address, y, regular)
  y = field(page, 'City',    idDetail.city,  y, regular)
  y = field(page, 'State',   idDetail.state, y, regular)

  if (idDetail.city?.trim() || idDetail.state?.trim()) y -= 4

  const phoneDisplay = phone.trim() || idDetail.phone?.trim()
  if (phoneDisplay) {
    const countryCode = idDetail.phoneCountryCode?.trim() || '+1'
    text(page, `Phone # ${countryCode} ${phoneDisplay}`, MARGIN, y, 9, regular)
    y -= 13
  }

  const emailDisplay = email.trim() || idDetail.email?.trim()
  y = field(page, 'Email', emailDisplay, y, regular)
  y -= 10

  hRule(page, y)
  y -= 18

  // ── ID INFORMATION ────────────────────────────────────────────────────────
  y = sectionHeader(page, 'ID INFORMATION', y, bold)
  y -= 4

  y = field(page, 'Type',        parsed.idType,    y, regular)
  y = field(page, 'Number',      parsed.idNumber,  y, regular)
  y = field(page, 'Issue Date',  parsed.issueDate, y, regular)
  y = field(page, 'Expire Date', parsed.expiryDate, y, regular)
  y -= 10

  hRule(page, y)
  y -= 18

  // ── PERSONAL INFORMATION ──────────────────────────────────────────────────
  y = sectionHeader(page, 'PERSONAL INFORMATION', y, bold)
  y -= 4

  const gender = normalizeGender(documentData?.gender ?? documentData?.sex)
  y = field(page, 'Gender', gender, y, regular)
  y = field(page, 'DOB', formatDobDisplay(parsed.dateOfBirth), y, regular)

  const ageYears = ageYearsFromDobString(parsed.dateOfBirth)
  if (ageYears !== null) {
    text(page, `Age: ${ageYears} Year(s)`, MARGIN, y, 9, regular)
    y -= 13
  }

  y -= 12

  // ── ID card image ─────────────────────────────────────────────────────────
  if (input.imageFrontBase64?.trim()) {
    try {
      const transformed = (input.rotationDeg !== 0 || input.flipH)
        ? await transformBase64ImageSync(input.imageFrontBase64, input.rotationDeg, input.flipH)
        : input.imageFrontBase64

      const mime = guessImageMimeFromBase64(transformed)
      let embeddedImage: PDFImage
      if (mime === 'image/jpeg') {
        embeddedImage = await pdfDoc.embedJpg(transformed)
      } else if (mime === 'image/png') {
        embeddedImage = await pdfDoc.embedPng(transformed)
      } else {
        const pngB64 = await transformBase64ImageSync(transformed, 0, false)
        embeddedImage = await pdfDoc.embedPng(pngB64)
      }

      const maxW = 250; const maxH = 170
      const { width: iw, height: ih } = embeddedImage
      const scale = Math.min(maxW / iw, maxH / ih)
      const drawW = iw * scale; const drawH = ih * scale
      const imgX = (PAGE_W - drawW) / 2
      const imgY = y - drawH

      page.drawImage(embeddedImage, { x: imgX, y: imgY, width: drawW, height: drawH })
      y = imgY - 10
    } catch {
      // Image embed failed — continue without it
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  const footerY1 = 36
  const footerY2 = 22

  if (hotel.name || hotel.city || hotel.state) {
    const footerParts = [hotel.name, hotel.city, hotel.state].filter(Boolean)
    centeredText(page, footerParts.join(' • '), footerY1, 9, regular, GRAY)
  }

  centeredText(page, formatFooterTimestamp(), footerY2, 9, regular, GRAY)

  page.drawLine({
    start:     { x: MARGIN, y: footerY1 + 14 },
    end:       { x: PAGE_W - MARGIN, y: footerY1 + 14 },
    thickness: 0.5,
    color:     LIGHT,
  })

  return pdfDoc.save()
}

// ── Cash Deposit Receipt ──────────────────────────────────────────────────────

type Seg = { text: string; bold?: boolean; ul?: boolean }

/**
 * Draw mixed regular/bold text with automatic word-wrap.
 * Returns y of the last line drawn; caller subtracts lineH to advance.
 */
function drawSegs(
  page: PDFPage,
  segs: Seg[],
  x0: number,
  y: number,
  size: number,
  reg: PDFFont,
  bld: PDFFont,
  maxW: number,
  lineH: number,
): number {
  const tokens: Array<{ word: string; bold: boolean; ul: boolean }> = []
  for (const seg of segs) {
    for (const w of seg.text.split(/\s+/).filter(Boolean)) {
      tokens.push({ word: w, bold: !!seg.bold, ul: !!seg.ul })
    }
  }
  let x = x0
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    const font = tok.bold ? bld : reg
    const ww = font.widthOfTextAtSize(tok.word, size)
    if (x > x0 && x + ww > x0 + maxW) { y -= lineH; x = x0 }
    page.drawText(tok.word, { x, y, size, font, color: BLACK })
    if (tok.ul) {
      page.drawLine({ start: { x, y: y - 1.5 }, end: { x: x + ww, y: y - 1.5 }, thickness: 0.5, color: BLACK })
    }
    x += ww
    if (i < tokens.length - 1) x += reg.widthOfTextAtSize(' ', size)
  }
  return y
}

/**
 * Two-column info grid row (CHECK IN DATE / GUEST NAME / ID NUMBER grid).
 * Values are bold; blank values show only the underline. Returns next y.
 */
function gridRow(
  page: PDFPage,
  leftLabel: string,  leftValue:  string | null,
  rightLabel: string, rightValue: string | null,
  y: number,
  reg: PDFFont,
  bld: PDFFont,
): number {
  const LS = 8;  const VS = 9
  const LVX = 153;  const LVE = 295
  const RLX = 315;  const RVX = 430;  const RVE = 562

  page.drawText(leftLabel,  { x: MARGIN, y, size: LS, font: reg, color: GRAY })
  if (leftValue?.trim())  page.drawText(leftValue.trim(),  { x: LVX, y, size: VS, font: bld, color: BLACK })
  page.drawLine({ start: { x: LVX, y: y - 2 }, end: { x: LVE, y: y - 2 }, thickness: 0.5, color: BLACK })

  page.drawText(rightLabel, { x: RLX, y, size: LS, font: reg, color: GRAY })
  if (rightValue?.trim()) page.drawText(rightValue.trim(), { x: RVX, y, size: VS, font: bld, color: BLACK })
  page.drawLine({ start: { x: RVX, y: y - 2 }, end: { x: RVE, y: y - 2 }, thickness: 0.5, color: BLACK })

  return y - 28
}

/**
 * Two-column row for CASH DEPOSIT RECEIVED / RETURNED sections.
 * Pre-filled value drawn as bold text; blank value = underline only.
 */
function receiptSigRow(
  page: PDFPage,
  leftLabel: string,  leftValue:  string | null,
  rightLabel: string, rightValue: string | null,
  y: number,
  reg: PDFFont,
  bld: PDFFont,
): void {
  const LS = 8;  const VS = 9
  const llw = reg.widthOfTextAtSize(leftLabel,  LS)
  const rlw = reg.widthOfTextAtSize(rightLabel, LS)
  const LVX = MARGIN + llw + 8;  const LVE = 292
  const RLX = 310
  const RVX = RLX + rlw + 8;    const RVE = PAGE_W - MARGIN

  page.drawText(leftLabel, { x: MARGIN, y, size: LS, font: reg, color: GRAY })
  if (leftValue?.trim()) {
    page.drawText(leftValue.trim(), { x: LVX, y, size: VS, font: bld, color: BLACK })
  }
  page.drawLine({ start: { x: LVX, y: y - 2 }, end: { x: LVE, y: y - 2 }, thickness: 0.5, color: BLACK })

  page.drawText(rightLabel, { x: RLX, y, size: LS, font: reg, color: GRAY })
  if (rightValue?.trim()) {
    page.drawText(rightValue.trim(), { x: RVX, y, size: VS, font: bld, color: BLACK })
  } else {
    page.drawLine({ start: { x: RVX, y: y - 2 }, end: { x: RVE, y: y - 2 }, thickness: 0.5, color: BLACK })
  }
}

export type CashDepositInput = {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  /** ISO scan/check-in timestamp — shown as CHECK IN DATE. */
  scanTime: string | null
  /** Pre-filled from loaded reservation; null = blank line. */
  roomNumber: string | null
  /** Confirmation number (SynXis) / registration number (eZee) — shown as FOLIO NUMBER. */
  confirmationNumber: string | null
  /** ISO date string for check-out; null = blank line. */
  checkOutDate: string | null
  hotel: HotelContact
}

export async function buildCashDepositReceiptPdf(input: CashDepositInput): Promise<Uint8Array> {
  const { idDetail, parsed, scanTime, roomNumber, confirmationNumber, checkOutDate, hotel } = input

  const pdfDoc = await PDFDocument.create()
  const reg = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bld = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const page = pdfDoc.addPage([PAGE_W, PAGE_H])
  const LH = 13

  let y = PAGE_H - MARGIN

  // ── Hotel header (centered) ───────────────────────────────────────────────
  if (hotel.name?.trim()) {
    const nw = bld.widthOfTextAtSize(hotel.name, 14)
    page.drawText(hotel.name, { x: (PAGE_W - nw) / 2, y, size: 14, font: bld, color: BLACK })
    y -= 20
  }
  if (hotel.address?.trim())     { centeredText(page, hotel.address, y, 9, reg, GRAY); y -= LH }
  const hCityLine = [hotel.city, hotel.state, hotel.zip].filter(Boolean).join(', ')
  if (hCityLine)                 { centeredText(page, hCityLine, y, 9, reg, GRAY); y -= LH }
  if (hotel.phone?.trim())       { centeredText(page, hotel.phone,  y, 9, reg, GRAY); y -= LH }
  if (hotel.email?.trim())       { centeredText(page, hotel.email,  y, 9, reg, GRAY); y -= LH }
  y -= 14

  // ── Info grid ─────────────────────────────────────────────────────────────
  // Guest name: LAST FIRST MIDDLE (uppercase, IDGuru style)
  const nameParts = [idDetail.lastName, idDetail.firstName, idDetail.middleName]
    .map(p => p?.trim().toUpperCase()).filter(Boolean)
  const guestName = nameParts.join(' ')

  y = gridRow(page, 'CHECK IN DATE', formatCheckInDisplay(scanTime),  'CHECK OUT DATE', formatDateDisplay(checkOutDate) || null, y, reg, bld)
  y = gridRow(page, 'GUEST NAME',    guestName || null,                'ROOM NUMBER',   roomNumber,                              y, reg, bld)
  y = gridRow(page, 'ID NUMBER',     parsed.idNumber?.trim() || null,  'FOLIO NUMBER',  confirmationNumber?.trim() || null,     y, reg, bld)

  y -= 18

  // ── Policy paragraph ──────────────────────────────────────────────────────
  const amt = `$${hotel.cashDepositAmount.toFixed(2)}`
  y = drawSegs(page, [
    { text: 'A ' },
    { text: amt, bold: true, ul: true },
    { text: ' CASH DEPOSIT IS REQUIRED FOR ALL GUESTS PAYING CASH WITHOUT AN AUTHORIZED CREDIT/DEBIT CARD.' },
  ], MARGIN, y, 9, reg, bld, COL_W, LH)
  y -= LH + 10

  // ── Return-conditions header ──────────────────────────────────────────────
  page.drawText('CASH DEPOSIT WILL BE RETURNED AT CHECK OUT AFTER:', {
    x: MARGIN, y, size: 12, font: bld, color: BLACK,
  })
  y -= 22

  // Bullet items — bullet char (U+2022) is in WinAnsiEncoding at 0x95
  const B  = '•'
  const bw = reg.widthOfTextAtSize(B, 9) + 6

  const drawBullet = (segs: Seg[]) => {
    page.drawText(B, { x: MARGIN, y, size: 9, font: reg, color: BLACK })
    y = drawSegs(page, segs, MARGIN + bw, y, 9, reg, bld, COL_W - bw, LH)
    y -= LH
  }

  drawBullet([{ text: 'THE ROOM IS VACANT' }])
  drawBullet([{ text: `A ${hotel.name?.trim() || 'HOTEL'} TEAM MEMBER CHECKS THE ROOM` }])
  drawBullet([
    { text: 'THERE HAS BEEN ' },
    { text: "NO EXCESSIVE DIRTY ROOM, NO DAMAGES, NO MISSING ITEMS, AND NO VIOLATION OF THE ROOM'S SMOKING POLICY", bold: true },
  ])
  drawBullet([{ text: 'SIGNED CASH DEPOSIT RECEIPT IS PRESENT', bold: true }])

  y -= 6

  // ── "Unless" paragraph (mixed bold) ──────────────────────────────────────
  y = drawSegs(page, [
    { text: 'Unless a Front Desk Agent is notified in advance and in writing, another person may not pick up the deposit; only the ' },
    { text: 'registered guests with ID', bold: true },
    { text: ' may. ' },
    { text: 'All cash deposits must be picked up by 12:00 pm the day of departure, or they will be forfeited.', bold: true },
  ], MARGIN, y, 9, reg, bld, COL_W, LH)
  y -= LH + 30

  // ── CASH DEPOSIT RECEIVED ─────────────────────────────────────────────────
  centeredText(page, 'CASH DEPOSIT RECEIVED', y, 11, bld)
  y -= 16
  hRule(page, y, BLACK)
  y -= 22

  receiptSigRow(page, 'GUEST SIGNATURE', null,                               'DATE',               formatFooterTimestamp(), y, reg, bld)
  y -= 28
  receiptSigRow(page, 'AMOUNT',          hotel.cashDepositAmount.toFixed(2), 'EMPLOYEE SIGNATURE', null,                   y, reg, bld)
  y -= 38

  // ── CASH DEPOSIT RETURNED TO GUEST ────────────────────────────────────────
  centeredText(page, 'CASH DEPOSIT RETURNED TO GUEST', y, 11, bld)
  y -= 16
  hRule(page, y, BLACK)
  y -= 22

  receiptSigRow(page, 'AMOUNT', null, 'EMPLOYEE SIGNATURE', null, y, reg, bld)
  y -= 28

  // Full-width guest signature line
  page.drawText('GUEST SIGNATURE', { x: MARGIN, y, size: 8, font: reg, color: GRAY })
  const gsw = reg.widthOfTextAtSize('GUEST SIGNATURE', 8)
  page.drawLine({
    start: { x: MARGIN + gsw + 8, y: y - 2 },
    end:   { x: PAGE_W - MARGIN,  y: y - 2 },
    thickness: 0.5,
    color: BLACK,
  })

  return pdfDoc.save()
}

// ── Wrapped-text helper ──────────────────────────────────────────────────────

function drawWrappedText(
  page: PDFPage,
  str: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  maxW: number,
  lineH: number,
  color = BLACK,
): number {
  const words = str.split(/\s+/).filter(Boolean)
  let cx = x
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const ww = font.widthOfTextAtSize(w, size)
    if (cx > x && cx + ww > x + maxW) { y -= lineH; cx = x }
    page.drawText(w, { x: cx, y, size, font, color })
    cx += ww
    if (i < words.length - 1) cx += font.widthOfTextAtSize(' ', size)
  }
  return y
}

// ── Police Report PDF ─────────────────────────────────────────────────────────

export type PoliceReportInput = {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  documentData: Record<string, unknown> | null
  imageFrontBase64: string | null
  rotationDeg: number
  flipH: boolean
  roomNumber: string | null
  confirmationNumber: string | null
  checkInDate: string | null
  hotel: HotelContact
}

export async function buildPoliceReportPdf(input: PoliceReportInput): Promise<Uint8Array> {
  const { idDetail, parsed, documentData, hotel } = input
  const pdfDoc = await PDFDocument.create()
  const reg = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bld = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const page = pdfDoc.addPage([PAGE_W, PAGE_H])
  const LH = 13

  let y = PAGE_H - MARGIN

  if (hotel.name?.trim()) {
    const nw = bld.widthOfTextAtSize(hotel.name, 14)
    page.drawText(hotel.name, { x: (PAGE_W - nw) / 2, y, size: 14, font: bld })
    y -= 20
  }
  const cityLine = [hotel.city, hotel.state, hotel.zip].filter(Boolean).join(', ')
  if (hotel.address?.trim()) { centeredText(page, hotel.address, y, 9, reg, GRAY); y -= LH }
  if (cityLine)              { centeredText(page, cityLine,      y, 9, reg, GRAY); y -= LH }
  if (hotel.phone?.trim())   { centeredText(page, hotel.phone,   y, 9, reg, GRAY); y -= LH }
  y -= 10

  centeredText(page, 'POLICE REPORT', y, 16, bld)
  y -= 10; hRule(page, y, BLACK); y -= 18

  page.drawText(`Date: ${formatFooterTimestamp()}`, { x: MARGIN, y, size: 9, font: reg })
  y -= 22

  y = sectionHeader(page, 'GUEST INFORMATION', y, bld)
  y -= 4

  const nameParts = [idDetail.firstName, idDetail.middleName, idDetail.lastName]
    .map(p => p?.trim()).filter(Boolean)
  const guestName = nameParts.join(' ') || parsed.fullName?.trim() || ''
  const gender = normalizeGender(documentData?.gender ?? documentData?.sex)
  const addr = [
    idDetail.streetAddress?.trim() || parsed.address?.trim(),
    idDetail.city?.trim(),
    idDetail.state?.trim(),
  ].filter(Boolean).join(', ')

  const infoRows: [string, string][] = [
    ['1. Guest Name',      guestName || '—'],
    ['2. Date of Birth',   formatDobDisplay(parsed.dateOfBirth) || '—'],
    ['3. Gender',          gender || '—'],
    ['4. ID Type',         parsed.idType?.trim() || '—'],
    ['5. ID Number',       parsed.idNumber?.trim() || '—'],
    ['6. Issue Date',      parsed.issueDate?.trim() || '—'],
    ['7. Expiry Date',     parsed.expiryDate?.trim() || '—'],
    ['8. Address',         addr || '—'],
    ['9. Room Number',     input.roomNumber?.trim() || '—'],
    ['10. Confirmation #', input.confirmationNumber?.trim() || '—'],
    ['11. Check-In Date',  formatDateDisplay(input.checkInDate) || '—'],
  ]

  for (const [label, value] of infoRows) {
    const lw = bld.widthOfTextAtSize(`${label}:`, 9)
    page.drawText(`${label}:`, { x: MARGIN, y, size: 9, font: bld })
    page.drawText(value, { x: MARGIN + lw + 6, y, size: 9, font: reg })
    y -= LH
  }

  y -= 10

  if (input.imageFrontBase64?.trim() && y > 180) {
    try {
      const src = (input.rotationDeg !== 0 || input.flipH)
        ? await transformBase64ImageSync(input.imageFrontBase64, input.rotationDeg, input.flipH)
        : input.imageFrontBase64
      const mime = guessImageMimeFromBase64(src)
      let img: PDFImage
      if (mime === 'image/jpeg')     img = await pdfDoc.embedJpg(src)
      else if (mime === 'image/png') img = await pdfDoc.embedPng(src)
      else                           img = await pdfDoc.embedPng(await transformBase64ImageSync(src, 0, false))

      y = sectionHeader(page, 'IDENTIFICATION DOCUMENT', y, bld); y -= 4
      const maxW = 260; const maxH = 170
      const scale = Math.min(maxW / img.width, maxH / img.height)
      const dw = img.width * scale; const dh = img.height * scale
      page.drawImage(img, { x: MARGIN, y: y - dh, width: dw, height: dh })
      y = y - dh - 12
    } catch { /* continue without image */ }
  }

  if (y > 140) {
    y -= 4; hRule(page, y); y -= 18
    y = sectionHeader(page, 'CERTIFICATION', y, bld); y -= 4
    y = drawWrappedText(page, 'I, the undersigned authorized representative of the above-named hotel, certify that the information contained in this report is true and accurate to the best of my knowledge. The guest information was obtained from a government-issued photo identification document presented at time of check-in.', MARGIN, y, 8.5, reg, COL_W, 12)
    y -= 28
  }

  const sigY = Math.max(y, 100)
  page.drawLine({ start: { x: MARGIN, y: sigY - 2 }, end: { x: 270,            y: sigY - 2 }, thickness: 0.5, color: BLACK })
  page.drawLine({ start: { x: 310,    y: sigY - 2 }, end: { x: PAGE_W - MARGIN, y: sigY - 2 }, thickness: 0.5, color: BLACK })
  page.drawText('Authorized Representative Signature', { x: MARGIN, y: sigY - 14, size: 7.5, font: reg, color: GRAY })
  page.drawText('Date',                                { x: 310,    y: sigY - 14, size: 7.5, font: reg, color: GRAY })

  const fy1 = 36; const fy2 = 22
  page.drawLine({ start: { x: MARGIN, y: fy1 + 14 }, end: { x: PAGE_W - MARGIN, y: fy1 + 14 }, thickness: 0.5, color: LIGHT })
  const fp = [hotel.name, hotel.city, hotel.state].filter(Boolean)
  if (fp.length) centeredText(page, fp.join(' • '), fy1, 9, reg, GRAY)
  centeredText(page, `Generated: ${formatFooterTimestamp()}`, fy2, 9, reg, GRAY)

  return pdfDoc.save()
}

// ── Registration Card PDF ─────────────────────────────────────────────────────

export type RegistrationCardInput = {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  phone: string
  email: string
  roomNumber: string | null
  confirmationNumber: string | null
  checkInDate: string | null
  checkOutDate: string | null
  hotel: HotelContact
  signaturePngDataUrl: string | null
}

const REG_CARD_TC: Array<{ heading: string; body: string }> = [
  {
    heading: 'RATES & CHARGES',
    body: 'Guest agrees to pay all room rates, taxes, and applicable fees. By providing a credit/debit card, guest authorizes the hotel to charge for all amounts incurred during the stay including incidentals. Final charges will be posted at checkout.',
  },
  {
    heading: 'CHECK-IN / CHECK-OUT',
    body: 'Check-in time is 3:00 PM. Check-out time is 11:00 AM. Early check-in and late check-out are subject to availability and may incur additional fees. Failure to vacate by checkout time may result in an additional night charge.',
  },
  {
    heading: 'SMOKING POLICY',
    body: 'This property is entirely non-smoking. Smoking is prohibited in all guest rooms, hallways, and indoor common areas. A cleaning fee of up to $250 will be charged for violations.',
  },
  {
    heading: 'DAMAGES & RESPONSIBILITY',
    body: "Guest is responsible for any damages to hotel property beyond normal wear and tear. Charges for damages may be applied to the credit card on file within 7 days of checkout.",
  },
  {
    heading: 'NOISE & CONDUCT',
    body: 'Quiet hours are 10:00 PM – 8:00 AM. Disruptive behavior may result in removal from the premises without refund. Hotel reserves the right to refuse or terminate service.',
  },
  {
    heading: 'LIABILITY',
    body: 'The hotel is not responsible for loss, theft, or damage to personal property. Safety deposit boxes are available at the front desk. Guests assume personal liability for any injury or loss during their stay.',
  },
]

export async function buildRegistrationCardPdf(input: RegistrationCardInput): Promise<Uint8Array> {
  const { idDetail, parsed, phone, email, hotel } = input
  const pdfDoc = await PDFDocument.create()
  const reg = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bld = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const page = pdfDoc.addPage([PAGE_W, PAGE_H])
  const LH = 12

  let y = PAGE_H - MARGIN

  if (hotel.name?.trim()) {
    const nw = bld.widthOfTextAtSize(hotel.name, 14)
    page.drawText(hotel.name, { x: (PAGE_W - nw) / 2, y, size: 14, font: bld })
    y -= 18
  }
  const cityLine = [hotel.city, hotel.state, hotel.zip].filter(Boolean).join(', ')
  if (hotel.address?.trim()) { centeredText(page, hotel.address, y, 8.5, reg, GRAY); y -= LH }
  if (cityLine)              { centeredText(page, cityLine,      y, 8.5, reg, GRAY); y -= LH }
  if (hotel.phone?.trim())   { centeredText(page, hotel.phone,   y, 8.5, reg, GRAY); y -= LH }
  y -= 6

  centeredText(page, 'GUEST REGISTRATION CARD', y, 13, bld)
  y -= 8; hRule(page, y, BLACK); y -= 16

  const nameParts = [idDetail.firstName, idDetail.middleName, idDetail.lastName]
    .map(p => p?.trim()).filter(Boolean)
  const guestName = nameParts.join(' ') || parsed.fullName?.trim() || ''

  y = gridRow(page, 'GUEST NAME',    guestName || null,                     'ROOM NUMBER',    input.roomNumber,                              y, reg, bld)
  y = gridRow(page, 'CHECK-IN DATE', formatDateDisplay(input.checkInDate),  'CHECK-OUT DATE', formatDateDisplay(input.checkOutDate) || null, y, reg, bld)
  y = gridRow(page, 'ID NUMBER',     parsed.idNumber?.trim() || null,       'CONFIRMATION #', input.confirmationNumber?.trim() || null,      y, reg, bld)

  const addrVal  = idDetail.streetAddress?.trim() || parsed.address?.trim() || null
  const phoneVal = phone.trim() || idDetail.phone?.trim() || null
  const emailVal = email.trim() || idDetail.email?.trim() || null

  const addrLabel = 'ADDRESS'
  const alw = reg.widthOfTextAtSize(addrLabel, 8)
  page.drawText(addrLabel, { x: MARGIN, y, size: 8, font: reg, color: GRAY })
  if (addrVal) page.drawText(addrVal, { x: MARGIN + alw + 6, y, size: 9, font: bld })
  page.drawLine({ start: { x: MARGIN + alw + 6, y: y - 2 }, end: { x: PAGE_W - MARGIN, y: y - 2 }, thickness: 0.5, color: BLACK })
  y -= 26

  y = gridRow(page, 'PHONE', phoneVal, 'EMAIL', emailVal, y, reg, bld)
  y -= 8

  hRule(page, y); y -= 14

  y = sectionHeader(page, 'TERMS AND CONDITIONS', y, bld); y -= 6

  for (const tc of REG_CARD_TC) {
    if (y < 120) break
    page.drawText(tc.heading, { x: MARGIN, y, size: 8, font: bld })
    y -= 12
    y = drawWrappedText(page, tc.body, MARGIN, y, 7.5, reg, COL_W, 11)
    y -= 17
  }

  hRule(page, y); y -= 14

  y = drawWrappedText(page, 'By signing below, I acknowledge that I have read, understand, and agree to the above Terms and Conditions. I authorize all charges as described above.', MARGIN, y, 8, reg, COL_W, 11)
  y -= 20

  if (input.signaturePngDataUrl) {
    try {
      const sigImg = await pdfDoc.embedPng(input.signaturePngDataUrl)
      const sigH = 36; const sigW = Math.min(sigImg.width * (36 / sigImg.height), 220)
      page.drawImage(sigImg, { x: MARGIN, y: y - sigH + 10, width: sigW, height: sigH })
      y -= sigH
    } catch { /* blank line */ }
  }

  page.drawLine({ start: { x: MARGIN, y: y - 2 }, end: { x: 310,            y: y - 2 }, thickness: 0.5, color: BLACK })
  page.drawLine({ start: { x: 330,    y: y - 2 }, end: { x: PAGE_W - MARGIN, y: y - 2 }, thickness: 0.5, color: BLACK })
  page.drawText('Guest Signature', { x: MARGIN, y: y - 14, size: 7.5, font: reg, color: GRAY })
  page.drawText('Date',            { x: 330,    y: y - 14, size: 7.5, font: reg, color: GRAY })
  y -= 26

  page.drawLine({ start: { x: MARGIN, y: y - 2 }, end: { x: 310, y: y - 2 }, thickness: 0.5, color: BLACK })
  if (guestName) page.drawText(guestName, { x: MARGIN, y, size: 8.5, font: bld })
  page.drawText('Print Name', { x: MARGIN, y: y - 14, size: 7.5, font: reg, color: GRAY })

  const fy1 = 36; const fy2 = 22
  page.drawLine({ start: { x: MARGIN, y: fy1 + 14 }, end: { x: PAGE_W - MARGIN, y: fy1 + 14 }, thickness: 0.5, color: LIGHT })
  const fp = [hotel.name, hotel.city, hotel.state].filter(Boolean)
  if (fp.length) centeredText(page, fp.join(' • '), fy1, 9, reg, GRAY)
  centeredText(page, `Generated: ${formatFooterTimestamp()}`, fy2, 9, reg, GRAY)

  return pdfDoc.save()
}

// ── Chargeback Evidence PDF ───────────────────────────────────────────────────

export type ChargebackEvidenceInput = {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  imageFrontBase64: string | null
  imageBackBase64: string | null
  rotationDeg: number
  flipH: boolean
  roomNumber: string | null
  confirmationNumber: string | null
  checkInDate: string | null
  checkOutDate: string | null
  hotel: HotelContact
  signaturePngDataUrl: string | null
}

export async function buildChargebackEvidencePdf(input: ChargebackEvidenceInput): Promise<Uint8Array> {
  const { idDetail, parsed, hotel } = input
  const pdfDoc = await PDFDocument.create()
  const reg = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bld = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const LH = 13
  const fy1 = 36; const fy2 = 22
  const fp = [hotel.name, hotel.city, hotel.state].filter(Boolean)
  const conf = input.confirmationNumber?.trim() || 'N/A'

  const addFooter = (pg: PDFPage) => {
    pg.drawLine({ start: { x: MARGIN, y: fy1 + 14 }, end: { x: PAGE_W - MARGIN, y: fy1 + 14 }, thickness: 0.5, color: LIGHT })
    if (fp.length) centeredText(pg, fp.join(' • '), fy1, 9, reg, GRAY)
    centeredText(pg, `Generated: ${formatFooterTimestamp()}`, fy2, 9, reg, GRAY)
  }

  const nameParts = [idDetail.firstName, idDetail.middleName, idDetail.lastName]
    .map(p => p?.trim()).filter(Boolean)
  const guestName = nameParts.join(' ') || parsed.fullName?.trim() || ''

  // ─── Page 1: Cover letter ─────────────────────────────────────────────────
  const pg1 = pdfDoc.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN

  if (hotel.name?.trim()) {
    const nw = bld.widthOfTextAtSize(hotel.name, 14)
    pg1.drawText(hotel.name, { x: (PAGE_W - nw) / 2, y, size: 14, font: bld })
    y -= 18
  }
  const cityLine = [hotel.city, hotel.state, hotel.zip].filter(Boolean).join(', ')
  if (hotel.address?.trim()) { centeredText(pg1, hotel.address, y, 9, reg, GRAY); y -= LH }
  if (cityLine)              { centeredText(pg1, cityLine,      y, 9, reg, GRAY); y -= LH }
  if (hotel.phone?.trim())   { centeredText(pg1, hotel.phone,   y, 9, reg, GRAY); y -= LH }
  y -= 10

  centeredText(pg1, 'CHARGEBACK EVIDENCE PACKAGE', y, 14, bld)
  y -= 8; hRule(pg1, y, BLACK); y -= 18

  pg1.drawText(`Date: ${formatFooterTimestamp()}`, { x: MARGIN, y, size: 9, font: reg }); y -= LH + 4
  pg1.drawText(`Re: Disputed Transaction — Confirmation No. ${conf}`, { x: MARGIN, y, size: 10, font: bld }); y -= LH + 10

  // Guest info box
  pg1.drawRectangle({ x: MARGIN, y: y - 62, width: COL_W, height: 70, borderColor: LIGHT, borderWidth: 0.75, color: rgb(0.97, 0.97, 0.97) })
  y -= 8
  pg1.drawText('Guest Name:',           { x: MARGIN + 10, y, size: 9, font: bld })
  pg1.drawText(guestName || '—',        { x: 200,         y, size: 9, font: reg }); y -= LH
  pg1.drawText('ID Number:',            { x: MARGIN + 10, y, size: 9, font: bld })
  pg1.drawText(parsed.idNumber?.trim() || '—', { x: 200, y, size: 9, font: reg }); y -= LH
  pg1.drawText('Room Number:',          { x: MARGIN + 10, y, size: 9, font: bld })
  pg1.drawText(input.roomNumber?.trim() || '—', { x: 200, y, size: 9, font: reg }); y -= LH
  pg1.drawText('Check-In / Check-Out:', { x: MARGIN + 10, y, size: 9, font: bld })
  pg1.drawText(`${formatDateDisplay(input.checkInDate) || '—'}  →  ${formatDateDisplay(input.checkOutDate) || '—'}`, { x: 200, y, size: 9, font: reg })
  y -= 22

  y = drawWrappedText(pg1, `This package is provided in response to a chargeback dispute for the above-referenced reservation. The guest was physically present at ${hotel.name?.trim() || 'our hotel'} and presented a valid government-issued photo identification at time of check-in. The documents enclosed confirm the guest's identity and their agreement to the hotel's terms and conditions.`, MARGIN, y, 9, reg, COL_W, LH)
  y -= LH + 14

  y = sectionHeader(pg1, 'ENCLOSED EXHIBITS', y, bld); y -= 6
  pg1.drawText('Exhibit A', { x: MARGIN,      y, size: 9, font: bld })
  pg1.drawText('—  Government-Issued Photo Identification (front and back)', { x: MARGIN + 60, y, size: 9, font: reg }); y -= LH + 2
  pg1.drawText('Exhibit B', { x: MARGIN,      y, size: 9, font: bld })
  pg1.drawText('—  Signed Guest Registration Card',                          { x: MARGIN + 60, y, size: 9, font: reg }); y -= LH + 16

  y = drawWrappedText(pg1, 'We respectfully request that this dispute be resolved in our favor based on the enclosed evidence. Should you require additional documentation, please contact us at the address or phone number above.', MARGIN, y, 9, reg, COL_W, LH)
  y -= LH + 20

  pg1.drawText('Sincerely,', { x: MARGIN, y, size: 9, font: reg }); y -= 32
  pg1.drawLine({ start: { x: MARGIN, y: y - 2 }, end: { x: 280,            y: y - 2 }, thickness: 0.5, color: BLACK })
  pg1.drawLine({ start: { x: 310,    y: y - 2 }, end: { x: PAGE_W - MARGIN, y: y - 2 }, thickness: 0.5, color: BLACK })
  pg1.drawText('Authorized Representative', { x: MARGIN, y: y - 14, size: 7.5, font: reg, color: GRAY })
  pg1.drawText('Date',                      { x: 310,    y: y - 14, size: 7.5, font: reg, color: GRAY })
  addFooter(pg1)

  // ─── Page 2: Exhibit A — ID images ───────────────────────────────────────
  const pg2 = pdfDoc.addPage([PAGE_W, PAGE_H])
  y = PAGE_H - MARGIN

  centeredText(pg2, 'EXHIBIT A — IDENTIFICATION DOCUMENTS', y, 13, bld); y -= 8
  hRule(pg2, y, BLACK); y -= 18
  pg2.drawText(`Confirmation No.: ${conf}`, { x: MARGIN, y, size: 9, font: reg, color: GRAY })
  pg2.drawText(`Guest: ${guestName || '—'}`, { x: 310, y, size: 9, font: reg, color: GRAY })
  y -= 22

  const tryEmbed = async (b64: string, rd: number, fh: boolean): Promise<PDFImage | null> => {
    try {
      const src = (rd !== 0 || fh) ? await transformBase64ImageSync(b64, rd, fh) : b64
      const mime = guessImageMimeFromBase64(src)
      if (mime === 'image/jpeg') return pdfDoc.embedJpg(src)
      if (mime === 'image/png')  return pdfDoc.embedPng(src)
      return pdfDoc.embedPng(await transformBase64ImageSync(src, 0, false))
    } catch { return null }
  }

  const drawIdCard = (pg: PDFPage, img: PDFImage, label: string, startY: number): number => {
    const maxW = COL_W; const maxH = 210
    const scale = Math.min(maxW / img.width, maxH / img.height)
    const dw = img.width * scale; const dh = img.height * scale
    const ix = (PAGE_W - dw) / 2
    pg.drawText(label, { x: MARGIN, y: startY, size: 9, font: bld })
    pg.drawImage(img, { x: ix, y: startY - dh - 6, width: dw, height: dh })
    return startY - dh - 22
  }

  const frontImg = input.imageFrontBase64?.trim() ? await tryEmbed(input.imageFrontBase64, input.rotationDeg, input.flipH) : null
  const backImg  = input.imageBackBase64?.trim()  ? await tryEmbed(input.imageBackBase64,  0,                  false)       : null

  if (frontImg) y = drawIdCard(pg2, frontImg, 'FRONT — Government-Issued Photo ID', y)
  else { pg2.drawText('[ Front ID image not available ]', { x: MARGIN, y, size: 9, font: reg, color: GRAY }); y -= 14 }

  if (backImg) { y -= 8; y = drawIdCard(pg2, backImg, 'BACK — Government-Issued Photo ID', y) }

  centeredText(pg2, '— End of Exhibit A —', 60, 9, reg, GRAY)
  addFooter(pg2)

  // ─── Page 3: Exhibit B — Signed registration card ────────────────────────
  const pg3 = pdfDoc.addPage([PAGE_W, PAGE_H])
  y = PAGE_H - MARGIN

  centeredText(pg3, 'EXHIBIT B — SIGNED REGISTRATION CARD', y, 13, bld); y -= 8
  hRule(pg3, y, BLACK); y -= 18
  pg3.drawText(`Confirmation No.: ${conf}`, { x: MARGIN, y, size: 9, font: reg, color: GRAY })
  pg3.drawText(`Guest: ${guestName || '—'}`, { x: 310, y, size: 9, font: reg, color: GRAY })
  y -= 22

  y = gridRow(pg3, 'GUEST NAME',    guestName || null,                     'ROOM NUMBER',    input.roomNumber,                              y, reg, bld)
  y = gridRow(pg3, 'CHECK-IN DATE', formatDateDisplay(input.checkInDate),  'CHECK-OUT DATE', formatDateDisplay(input.checkOutDate) || null, y, reg, bld)
  y = gridRow(pg3, 'ID NUMBER',     parsed.idNumber?.trim() || null,       'CONFIRMATION #', conf,                                          y, reg, bld)
  y -= 10

  hRule(pg3, y); y -= 14
  y = sectionHeader(pg3, 'TERMS AND CONDITIONS — ACKNOWLEDGED', y, bld); y -= 6

  for (const tc of REG_CARD_TC) {
    if (y < 150) break
    pg3.drawText(tc.heading, { x: MARGIN, y, size: 8, font: bld }); y -= 12
    y = drawWrappedText(pg3, tc.body, MARGIN, y, 7.5, reg, COL_W, 11)
    y -= 15
  }

  hRule(pg3, y); y -= 14
  y = drawWrappedText(pg3, 'Guest signature below confirms agreement to the above Terms and Conditions and authorization of all charges.', MARGIN, y, 8, reg, COL_W, 11)
  y -= 20

  if (input.signaturePngDataUrl) {
    try {
      const sigImg = await pdfDoc.embedPng(input.signaturePngDataUrl)
      const sigH = 42; const sigW = Math.min(sigImg.width * (42 / sigImg.height), 240)
      pg3.drawImage(sigImg, { x: MARGIN, y: y - sigH + 8, width: sigW, height: sigH })
      y -= sigH
    } catch { /* blank line */ }
  }

  pg3.drawLine({ start: { x: MARGIN, y: y - 2 }, end: { x: 310,            y: y - 2 }, thickness: 0.5, color: BLACK })
  pg3.drawLine({ start: { x: 330,    y: y - 2 }, end: { x: PAGE_W - MARGIN, y: y - 2 }, thickness: 0.5, color: BLACK })
  pg3.drawText('Guest Signature', { x: MARGIN, y: y - 14, size: 7.5, font: reg, color: GRAY })
  pg3.drawText('Date',            { x: 330,    y: y - 14, size: 7.5, font: reg, color: GRAY })
  y -= 26
  pg3.drawLine({ start: { x: MARGIN, y: y - 2 }, end: { x: 310, y: y - 2 }, thickness: 0.5, color: BLACK })
  if (guestName) pg3.drawText(guestName, { x: MARGIN, y, size: 8.5, font: bld })
  pg3.drawText('Print Name', { x: MARGIN, y: y - 14, size: 7.5, font: reg, color: GRAY })

  centeredText(pg3, '— End of Exhibit B —', 60, 9, reg, GRAY)
  addFooter(pg3)

  return pdfDoc.save()
}

// ── Pet Policy PDF ────────────────────────────────────────────────────────────

export type PetPolicyInput = {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  roomNumber: string | null
  confirmationNumber: string | null
  checkInDate: string | null
  checkOutDate: string | null
  hotel: HotelContact
  signaturePngDataUrl: string | null
}

export async function buildPetPolicyPdf(input: PetPolicyInput): Promise<Uint8Array> {
  const { idDetail, parsed, hotel } = input
  const pdfDoc = await PDFDocument.create()
  const reg = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bld = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const page = pdfDoc.addPage([PAGE_W, PAGE_H])
  const LH = 13

  let y = PAGE_H - MARGIN

  if (hotel.name?.trim()) {
    const nw = bld.widthOfTextAtSize(hotel.name, 14)
    page.drawText(hotel.name, { x: (PAGE_W - nw) / 2, y, size: 14, font: bld })
    y -= 18
  }
  const cityLine = [hotel.city, hotel.state, hotel.zip].filter(Boolean).join(', ')
  if (hotel.address?.trim()) { centeredText(page, hotel.address, y, 9, reg, GRAY); y -= LH }
  if (cityLine)              { centeredText(page, cityLine,      y, 9, reg, GRAY); y -= LH }
  if (hotel.phone?.trim())   { centeredText(page, hotel.phone,   y, 9, reg, GRAY); y -= LH }
  y -= 8

  centeredText(page, 'PET POLICY AGREEMENT', y, 13, bld)
  y -= 8; hRule(page, y, BLACK); y -= 16

  const nameParts = [idDetail.firstName, idDetail.middleName, idDetail.lastName]
    .map(p => p?.trim()).filter(Boolean)
  const guestName = nameParts.join(' ') || parsed.fullName?.trim() || ''

  y = gridRow(page, 'GUEST NAME',    guestName || null,                    'ROOM NUMBER',    input.roomNumber,                              y, reg, bld)
  y = gridRow(page, 'CHECK-IN DATE', formatDateDisplay(input.checkInDate), 'CHECK-OUT DATE', formatDateDisplay(input.checkOutDate) || null, y, reg, bld)
  y -= 10

  y = sectionHeader(page, 'PET INFORMATION', y, bld); y -= 4

  const blankField = (label: string): number => {
    const lw = reg.widthOfTextAtSize(`${label}:`, 8.5)
    page.drawText(`${label}:`, { x: MARGIN, y, size: 8.5, font: reg, color: GRAY })
    page.drawLine({ start: { x: MARGIN + lw + 6, y: y - 2 }, end: { x: PAGE_W - MARGIN, y: y - 2 }, thickness: 0.5, color: BLACK })
    return y - 22
  }

  y = blankField('Number of Pets')
  y = blankField('Pet Name(s), Breed(s), and Color(s)')
  y = blankField('Weight(s)')
  y -= 6

  hRule(page, y); y -= 14

  y = sectionHeader(page, 'PET POLICY', y, bld); y -= 6

  const B  = '•'
  const bw = reg.widthOfTextAtSize(B, 9) + 6

  const drawBullet = (segs: Seg[]) => {
    page.drawText(B, { x: MARGIN, y, size: 9, font: reg })
    y = drawSegs(page, segs, MARGIN + bw, y, 9, reg, bld, COL_W - bw, LH)
    y -= LH
  }

  drawBullet([{ text: 'A maximum of ' }, { text: '2 pets per room', bold: true }, { text: ' are permitted. Each pet must not exceed ' }, { text: '50 lbs.', bold: true }])
  drawBullet([{ text: 'A non-refundable ' }, { text: 'pet fee of $75.00 per stay', bold: true }, { text: ' applies per pet.' }])
  drawBullet([{ text: 'Pets must be kept on a leash or in a carrier at all times in public areas of the hotel.' }])
  drawBullet([{ text: 'Pets may not be left unattended in the guest room at any time.' }])
  drawBullet([{ text: 'Pets are not permitted in the pool area, fitness center, restaurant, or other food service areas.' }])
  drawBullet([{ text: 'Guest is responsible for any damages caused by the pet. Charges will be billed to the credit card on file.' }])
  drawBullet([{ text: 'Guests must clean up after their pet both inside and outside the hotel. Failure to do so may result in a cleaning fee.' }])
  drawBullet([{ text: 'Disruptive pet behavior (excessive barking, aggression, etc.) may result in the pet and guest being asked to vacate without refund.' }])
  drawBullet([{ text: 'The hotel is not responsible for the injury, loss, or theft of any pet.' }])

  y -= 6
  hRule(page, y); y -= 14

  y = drawWrappedText(page, 'By signing below, I acknowledge that I have read and agree to the above Pet Policy. I accept financial responsibility for any damages, fees, or liability arising from my pet(s) during my stay.', MARGIN, y, 8.5, reg, COL_W, LH)
  y -= 20

  if (input.signaturePngDataUrl) {
    try {
      const sigImg = await pdfDoc.embedPng(input.signaturePngDataUrl)
      const sigH = 36; const sigW = Math.min(sigImg.width * (36 / sigImg.height), 220)
      page.drawImage(sigImg, { x: MARGIN, y: y - sigH + 10, width: sigW, height: sigH })
      y -= sigH
    } catch { /* blank line */ }
  }

  page.drawLine({ start: { x: MARGIN, y: y - 2 }, end: { x: 310,            y: y - 2 }, thickness: 0.5, color: BLACK })
  page.drawLine({ start: { x: 330,    y: y - 2 }, end: { x: PAGE_W - MARGIN, y: y - 2 }, thickness: 0.5, color: BLACK })
  page.drawText('Guest Signature', { x: MARGIN, y: y - 14, size: 7.5, font: reg, color: GRAY })
  page.drawText('Date',            { x: 330,    y: y - 14, size: 7.5, font: reg, color: GRAY })
  y -= 26

  page.drawLine({ start: { x: MARGIN, y: y - 2 }, end: { x: 310, y: y - 2 }, thickness: 0.5, color: BLACK })
  if (guestName) page.drawText(guestName, { x: MARGIN, y, size: 8.5, font: bld })
  page.drawText('Print Name', { x: MARGIN, y: y - 14, size: 7.5, font: reg, color: GRAY })

  const fy1 = 36; const fy2 = 22
  page.drawLine({ start: { x: MARGIN, y: fy1 + 14 }, end: { x: PAGE_W - MARGIN, y: fy1 + 14 }, thickness: 0.5, color: LIGHT })
  const fp = [hotel.name, hotel.city, hotel.state].filter(Boolean)
  if (fp.length) centeredText(page, fp.join(' • '), fy1, 9, reg, GRAY)
  centeredText(page, `Generated: ${formatFooterTimestamp()}`, fy2, 9, reg, GRAY)

  return pdfDoc.save()
}

// ── Download helper ───────────────────────────────────────────────────────────

export function downloadPdfBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
