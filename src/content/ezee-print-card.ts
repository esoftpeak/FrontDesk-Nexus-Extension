/**
 * Injected on all live.ipms247.com/* pages.
 *
 * The eZee "Print Guest Registration Card" opens a Stimulsoft HTML5 viewer
 * as a MODAL on the same page (not a separate popup). This script keeps a
 * persistent MutationObserver alive for the lifetime of the tab, so it
 * detects the viewer the moment it appears — regardless of when the user
 * clicks the button.
 *
 * Flow: viewer appears → wait for AJAX report data to render → html2canvas
 * capture → pdf-lib PDF → store as regCardData → open signing window.
 */
import html2canvas from 'html2canvas'
import { PDFDocument } from 'pdf-lib'

/** Root element of the Stimulsoft rendered page — unique to the print modal. */
const CARD_SELECTOR = '.stiJsViewerPageShadow'

/**
 * The card has ~30+ <tr> rows when fully rendered.
 * We wait until at least this many exist before capturing.
 */
const MIN_ROWS = 15

/**
 * Extra settle time (ms) after MIN_ROWS is reached — lets the final AJAX
 * data finish painting before html2canvas runs.
 */
const SETTLE_MS = 1200

const CONTENT_TIMEOUT_MS = 15_000
const CONTENT_POLL_MS    = 300

let capturing = false

// ── Banner ────────────────────────────────────────────────────────────────────

function showBanner(msg: string, bg: string): void {
  let el = document.getElementById('fdn-print-banner')
  if (!el) {
    el = document.createElement('div')
    el.id = 'fdn-print-banner'
    Object.assign(el.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '2147483647', padding: '8px 22px', borderRadius: '6px',
      fontFamily: 'sans-serif', fontSize: '13px', fontWeight: '600',
      color: '#fff', boxShadow: '0 2px 10px rgba(0,0,0,.4)',
      pointerEvents: 'none', transition: 'background .25s',
    })
    document.body.appendChild(el)
  }
  el.style.background = bg
  el.textContent = msg
}

function removeBanner(): void {
  document.getElementById('fdn-print-banner')?.remove()
}

// ── Wait for report content to render ────────────────────────────────────────

function waitForContent(cardEl: HTMLElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + CONTENT_TIMEOUT_MS
    const id = window.setInterval(() => {
      const rows = cardEl.querySelectorAll('tr').length
      if (rows >= MIN_ROWS) {
        window.clearInterval(id)
        resolve()
      } else if (Date.now() > deadline) {
        window.clearInterval(id)
        reject(new Error(`Card content did not reach ${MIN_ROWS} rows within timeout (got ${rows})`))
      }
    }, CONTENT_POLL_MS)
  })
}

// ── Capture element → base64 PDF ─────────────────────────────────────────────

async function captureCardAsPdfBase64(cardEl: HTMLElement): Promise<string> {
  const canvas = await html2canvas(cardEl, {
    scale: 2,
    useCORS: true,
    logging: false,
    backgroundColor: '#ffffff',
    scrollX: 0,
    scrollY: 0,
  })

  const dataUrl  = canvas.toDataURL('image/png')
  const b64raw   = dataUrl.split(',')[1]!
  const imgBytes = Uint8Array.from(atob(b64raw), (c) => c.charCodeAt(0))

  const pdfDoc   = await PDFDocument.create()
  const pngImage = await pdfDoc.embedPng(imgBytes)
  const { width: imgW, height: imgH } = pngImage.scale(1)

  const page = pdfDoc.addPage([imgW, imgH])
  page.drawImage(pngImage, { x: 0, y: 0, width: imgW, height: imgH })

  const pdfBytes = await pdfDoc.save()
  let binary = ''
  for (let i = 0; i < pdfBytes.length; i++) binary += String.fromCharCode(pdfBytes[i])
  return btoa(binary)
}

// ── Main capture flow ─────────────────────────────────────────────────────────

async function captureCard(cardEl: HTMLElement): Promise<void> {
  console.log('[FDN eZee] Stimulsoft viewer appeared — waiting for report data to load...')
  showBanner('FrontDesk Nexus: waiting for report…', '#1565c0')

  // 1. Wait for rows to reach MIN_ROWS (report AJAX complete)
  await waitForContent(cardEl)

  // 2. Extra settle — let final paint finish
  console.log(`[FDN eZee] Report rows ready (${cardEl.querySelectorAll('tr').length} rows) — settling ${SETTLE_MS}ms...`)
  showBanner('FrontDesk Nexus: capturing card…', '#1565c0')
  await new Promise<void>((r) => window.setTimeout(r, SETTLE_MS))

  // 3. Capture
  const pdfBase64 = await captureCardAsPdfBase64(cardEl)

  // 4. Read active reservation for confirmation number
  const stored = await chrome.storage.local.get('fdn_active_reservation')
  const res = stored.fdn_active_reservation as { confirmationNumber?: string } | undefined
  const confirmation = res?.confirmationNumber?.trim() ?? ''

  // 5. Store for signing window (same key as SynXis flow)
  await chrome.storage.local.set({ regCardData: { pdfBase64, confirmation } })

  console.log(
    '[FDN eZee] Registration card PDF captured ✓',
    '| confirmation:', confirmation || '(unknown)',
    '| base64 length:', pdfBase64.length,
  )
  showBanner('FrontDesk Nexus: card captured ✓ — opening signing window…', '#2e7d32')

  // 6. Open the signing window (same as SynXis)
  const pageUrl = chrome.runtime.getURL('registration-card.html')
  window.open(pageUrl, '_blank', 'popup,left=3200,top=500,width=600,height=900')

  window.setTimeout(removeBanner, 3000)
}

// ── Persistent observer — stays alive for the full lifetime of the tab ────────

const viewerObserver = new MutationObserver(() => {
  if (capturing) return
  const cardEl = document.querySelector<HTMLElement>(CARD_SELECTOR)
  if (!cardEl) return

  capturing = true
  void captureCard(cardEl)
    .catch((err: unknown) => {
      console.error('[FDN eZee] Print card capture failed:', err)
      showBanner('FrontDesk Nexus: capture failed — see console', '#c62828')
    })
    .finally(() => {
      capturing = false
    })
})

viewerObserver.observe(document.documentElement, {
  childList: true,
  subtree:   true,
})

console.info('[FDN eZee] Print card observer active — waiting for Stimulsoft viewer...')
