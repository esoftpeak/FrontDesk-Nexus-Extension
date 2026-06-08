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
  /** ISO date string for check-out; null = blank line. */
  checkOutDate: string | null
  hotel: HotelContact
}

export async function buildCashDepositReceiptPdf(input: CashDepositInput): Promise<Uint8Array> {
  const { idDetail, parsed, scanTime, roomNumber, checkOutDate, hotel } = input

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
  y = gridRow(page, 'ID NUMBER',     parsed.idNumber?.trim() || null,  'FOLIO NUMBER',  null,                                   y, reg, bld)

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
