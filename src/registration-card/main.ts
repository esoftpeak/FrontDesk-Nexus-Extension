import { PDFDocument } from 'pdf-lib'

// ── Signature position on PDF page (points, origin = bottom-left corner) ────────
// US Letter page = 612 × 792 pts. Y increases upward from the page bottom.
// "Guest Signature:" underline sits at ~258 pts from bottom (~33% up the page).
// The image bottom-left corner is placed at (SIG_X, SIG_Y); image extends upward by SIG_H.
// Tweak SIG_Y up/down if the overlay drifts — each ~14 pts ≈ one text line.
const SIG_X = 140   // points from left edge  (just after "Guest Signature:" label text)
const SIG_Y = 350   // points from bottom edge — each ~14 pts = 1 text line
const SIG_W = 200   // width  (spans the underline)
const SIG_H = 40    // height (extends upward above the line)

type RegCardData = { pdfBase64: string; confirmation: string }

let currentPdfBytes: Uint8Array | null = null
let currentPdfUrl: string | null = null

async function init() {
  const result = await chrome.storage.local.get('regCardData') as { regCardData?: RegCardData }
  const data = result.regCardData
  if (!data) {
    document.body.innerHTML = '<p style="padding:2rem;color:red;font-family:sans-serif">No PDF data found. Please close this window and try again.</p>'
    return
  }

  document.getElementById('confLabel')!.textContent = data.confirmation

  // Parse base64 → bytes
  const raw = data.pdfBase64.includes(',') ? data.pdfBase64.split(',')[1]! : data.pdfBase64
  const binary = atob(raw)
  currentPdfBytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) currentPdfBytes[i] = binary.charCodeAt(i)

  showPdf(currentPdfBytes)
  setupSignatureCanvas()
  await moveToSecondScreen()
}

function showPdf(bytes: Uint8Array) {
  if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl)
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' })
  currentPdfUrl = URL.createObjectURL(blob)
  ;(document.getElementById('pdfEmbed') as HTMLIFrameElement).src = currentPdfUrl
}

// ── Window Management: move popup to second monitor ──────────────────────────────
async function moveToSecondScreen() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const screenDetails = await (window as any).getScreenDetails() as {
      screens: Array<{ availLeft: number; availTop: number; availWidth: number; availHeight: number; label?: string; isPrimary?: boolean }>
    }
    const screens = screenDetails.screens
    console.log('[FDN RegCard] Screens:', screens.map((s, i) => `${i}: ${s.label ?? 'screen'} ${s.availWidth}×${s.availHeight} primary=${s.isPrimary}`))

    const second = screens.find(s => s.isPrimary === false) ?? screens[1]
    if (!second) { console.log('[FDN RegCard] Only one screen — staying on current screen'); return }

    // chrome.windows.update is far more reliable than window.moveTo/resizeTo for cross-screen moves
    const win = await chrome.windows.getCurrent()
    if (win.id !== undefined) {
      await chrome.windows.update(win.id, {
        left:   second.availLeft,
        top:    second.availTop,
        width:  second.availWidth,
        height: second.availHeight,
        state:  'normal',
      })
      console.log('[FDN RegCard] Moved to tablet screen:', second.label ?? 'second screen', `${second.availWidth}×${second.availHeight}`)
    }
  } catch (e) {
    console.warn('[FDN RegCard] Window Management API unavailable:', e)
  }
}

// ── Signature canvas ──────────────────────────────────────────────────────────────
function setupSignatureCanvas() {
  const canvas  = document.getElementById('sigCanvas')  as HTMLCanvasElement
  const modal   = document.getElementById('signModal')  as HTMLDivElement
  const status  = document.getElementById('sigStatus')  as HTMLParagraphElement
  const ctx     = canvas.getContext('2d')!

  ctx.strokeStyle = '#1a237e'
  ctx.lineWidth   = 2
  ctx.lineCap     = 'round'
  ctx.lineJoin    = 'round'

  let drawing = false

  function getPos(e: MouseEvent | TouchEvent) {
    const r   = canvas.getBoundingClientRect()
    const src = 'touches' in e ? e.touches[0] : e
    return { x: src.clientX - r.left, y: src.clientY - r.top }
  }

  canvas.addEventListener('mousedown',  e => { drawing = true; ctx.beginPath(); const p = getPos(e); ctx.moveTo(p.x, p.y) })
  canvas.addEventListener('mousemove',  e => { if (!drawing) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke() })
  canvas.addEventListener('mouseup',    () => { drawing = false })
  canvas.addEventListener('mouseleave', () => { drawing = false })
  canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing = true; ctx.beginPath(); const p = getPos(e); ctx.moveTo(p.x, p.y) }, { passive: false })
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); if (!drawing) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke() }, { passive: false })
  canvas.addEventListener('touchend',   () => { drawing = false })

  document.getElementById('btnSignHere')!.onclick = () => {
    status.textContent = ''
    status.className = 'status'
    modal.classList.add('open')
  }

  document.getElementById('btnClear')!.onclick  = () => ctx.clearRect(0, 0, canvas.width, canvas.height)
  document.getElementById('btnCancel')!.onclick = () => modal.classList.remove('open')

  document.getElementById('btnSave')!.onclick = () => void embedSignature(canvas, modal, status)
}

// ── Embed signature into PDF using pdf-lib ────────────────────────────────────────
async function embedSignature(canvas: HTMLCanvasElement, modal: HTMLElement, status: HTMLElement) {
  if (!currentPdfBytes) return

  const btn = document.getElementById('btnSave') as HTMLButtonElement
  btn.disabled = true
  btn.textContent = 'Saving…'

  try {
    const pngDataUrl  = canvas.toDataURL('image/png')
    const pdfDoc      = await PDFDocument.load(currentPdfBytes)
    const pngImage    = await pdfDoc.embedPng(pngDataUrl)
    const page        = pdfDoc.getPages()[0]

    page.drawImage(pngImage, { x: SIG_X, y: SIG_Y, width: SIG_W, height: SIG_H })

    const savedBytes = await pdfDoc.save()
    currentPdfBytes = savedBytes
    showPdf(savedBytes)

    modal.classList.remove('open')
    status.textContent = '✓ Signature saved'
    status.className = 'status ok'
    console.log('[FDN RegCard] Signature embedded into PDF ✓ (x=%d y=%d w=%d h=%d)', SIG_X, SIG_Y, SIG_W, SIG_H)
  } catch (e) {
    console.error('[FDN RegCard] Failed to embed signature:', e)
    status.textContent = 'Failed to embed signature — see console'
    status.className = 'status err'
  } finally {
    btn.disabled = false
    btn.textContent = 'Save Signature'
  }
}

void init()
