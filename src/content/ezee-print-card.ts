/**
 * Injected on all live.ipms247.com/* pages.
 * Activates ONLY when a Stimulsoft print viewer is detected (the eZee
 * "Print Guest Registration Card" popup). Captures the rendered card,
 * converts it to a PDF, and opens the FDN registration-card signing window
 * — the same flow used for SynXis.
 */
import html2canvas from 'html2canvas'
import { PDFDocument } from 'pdf-lib'

/** Root element of the Stimulsoft rendered page — unique to the print popup. */
const CARD_SELECTOR   = '.stiJsViewerPageShadow'
const VIEWER_SELECTOR = '[id*="StiViewer"], .stiJsViewerReportPanel'

const RENDER_POLL_MS = 400
const RENDER_TIMEOUT_MS = 15_000
const APPEAR_TIMEOUT_MS  = 4_000 // how long to wait for viewer on non-print pages

// ── 1. Bail out quickly on normal eZee pages ──────────────────────────────────

async function waitForViewerOrExit(): Promise<boolean> {
  if (document.querySelector(CARD_SELECTOR) || document.querySelector(VIEWER_SELECTOR)) {
    return true
  }
  return new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => { obs.disconnect(); resolve(false) }, APPEAR_TIMEOUT_MS)
    const obs = new MutationObserver(() => {
      if (document.querySelector(CARD_SELECTOR) || document.querySelector(VIEWER_SELECTOR)) {
        obs.disconnect()
        window.clearTimeout(timer)
        resolve(true)
      }
    })
    obs.observe(document.documentElement, { childList: true, subtree: true })
  })
}

// ── 2. Wait for the card to finish rendering ──────────────────────────────────

function waitForCard(): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + RENDER_TIMEOUT_MS
    const id = window.setInterval(() => {
      const el = document.querySelector<HTMLElement>(CARD_SELECTOR)
      if (el && el.getBoundingClientRect().width > 0) {
        window.clearInterval(id)
        resolve(el)
      } else if (Date.now() > deadline) {
        window.clearInterval(id)
        reject(new Error('[FDN eZee] Card element did not render within timeout'))
      }
    }, RENDER_POLL_MS)
  })
}

// ── 3. Capture → PDF ──────────────────────────────────────────────────────────

async function captureCardAsPdfBase64(cardEl: HTMLElement): Promise<string> {
  const canvas = await html2canvas(cardEl, {
    scale: 2,           // 2× resolution for sharp signature area
    useCORS: true,
    logging: false,
    backgroundColor: '#ffffff',
    scrollX: 0,
    scrollY: 0,
  })

  const dataUrl = canvas.toDataURL('image/png')
  const b64     = dataUrl.split(',')[1]!
  const imgBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

  const pdfDoc   = await PDFDocument.create()
  const pngImage = await pdfDoc.embedPng(imgBytes)
  const { width: imgW, height: imgH } = pngImage.scale(1)

  // Page dimensions match the captured image so the signature overlay aligns
  const page = pdfDoc.addPage([imgW, imgH])
  page.drawImage(pngImage, { x: 0, y: 0, width: imgW, height: imgH })

  const pdfBytes = await pdfDoc.save()
  let binary = ''
  for (let i = 0; i < pdfBytes.length; i++) binary += String.fromCharCode(pdfBytes[i])
  return btoa(binary)
}

// ── 4. Show a non-blocking status banner ──────────────────────────────────────

function showBanner(msg: string, colour: string): HTMLElement {
  let el = document.getElementById('fdn-capture-banner')
  if (!el) {
    el = document.createElement('div')
    el.id = 'fdn-capture-banner'
    Object.assign(el.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '999999', padding: '8px 20px', borderRadius: '6px',
      fontFamily: 'sans-serif', fontSize: '13px', fontWeight: '600',
      color: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,.35)',
      pointerEvents: 'none', transition: 'background .3s',
    })
    document.body.appendChild(el)
  }
  el.style.background = colour
  el.textContent = msg
  return el
}

// ── 5. Main ───────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const found = await waitForViewerOrExit()
  if (!found) return  // not a print popup — exit silently

  console.log('[FDN eZee] Print card popup detected — waiting for render...')
  showBanner('FrontDesk Nexus: preparing registration card…', '#1565c0')

  try {
    const cardEl = await waitForCard()
    console.log('[FDN eZee] Card rendered ✓ — capturing...')
    showBanner('FrontDesk Nexus: capturing card…', '#1565c0')

    // Recover confirmation from the active reservation stored by the main eZee script
    const stored = await chrome.storage.local.get('fdn_active_reservation')
    const res = stored.fdn_active_reservation as { confirmationNumber?: string } | undefined
    const confirmation = res?.confirmationNumber?.trim() ?? ''

    const pdfBase64 = await captureCardAsPdfBase64(cardEl)

    await chrome.storage.local.set({ regCardData: { pdfBase64, confirmation } })

    console.log('[FDN eZee] Card captured ✓ | confirmation:', confirmation || '(unknown)')
    showBanner('FrontDesk Nexus: opening signing window…', '#2e7d32')

    const pageUrl = chrome.runtime.getURL('registration-card.html')
    window.open(pageUrl, '_blank', 'popup,left=3200,top=500,width=600,height=900')

    window.setTimeout(() => {
      document.getElementById('fdn-capture-banner')?.remove()
    }, 3000)
  } catch (err) {
    console.error('[FDN eZee] Print card capture failed:', err)
    showBanner('FrontDesk Nexus: capture failed — see console', '#c62828')
  }
}

void run()
