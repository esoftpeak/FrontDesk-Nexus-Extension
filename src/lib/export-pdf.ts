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

/** Normalize raw gender value ("M" → "Male", "F" → "Female", others as-is). */
function normalizeGender(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  const g = raw.trim()
  if (g.toLowerCase() === 'm' || g.toLowerCase() === 'male')   return 'Male'
  if (g.toLowerCase() === 'f' || g.toLowerCase() === 'female') return 'Female'
  return g
}

// ── Main export ──────────────────────────────────────────────────────────────

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
      // Apply UI rotation/flip so the PDF matches what the agent sees on screen.
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
        // BMP: transformBase64ImageSync uses a canvas which always outputs PNG
        const pngB64 = await transformBase64ImageSync(transformed, 0, false)
        embeddedImage = await pdfDoc.embedPng(pngB64)
      }

      // Scale to fit within a 250pt-wide, 170pt-tall box (typical DL ratio)
      const maxW = 250
      const maxH = 170
      const { width: iw, height: ih } = embeddedImage
      const scale = Math.min(maxW / iw, maxH / ih)
      const drawW = iw * scale
      const drawH = ih * scale
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
    const footerLine = footerParts.join(' • ')  // bullet separator
    centeredText(page, footerLine, footerY1, 9, regular, GRAY)
  }

  centeredText(page, formatFooterTimestamp(), footerY2, 9, regular, GRAY)

  // Thin top border above footer
  page.drawLine({
    start:     { x: MARGIN, y: footerY1 + 14 },
    end:       { x: PAGE_W - MARGIN, y: footerY1 + 14 },
    thickness: 0.5,
    color:     LIGHT,
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
