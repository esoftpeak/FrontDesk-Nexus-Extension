import { PDFDocument } from 'pdf-lib'

// ── Signature position on PDF page (points, origin = bottom-left corner) ────────
// US Letter page = 612 × 792 pts. Y increases upward from the page bottom.
// "Guest Signature:" underline sits at ~258 pts from bottom (~33% up the page).
// The image bottom-left corner is placed at (SIG_X, SIG_Y); image extends upward by SIG_H.
// Tweak SIG_Y up/down if the overlay drifts — each ~14 pts ≈ one text line.
const SIG_X = 140   // points from left edge  (just after "Guest Signature:" label text)
const SIG_Y = 310   // points from bottom edge — each ~14 pts = 1 text line
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
  window.setTimeout(() => {
    document.getElementById('signModal')!.classList.add('open')
  }, 1000)
  await moveToSecondScreen()
}

function showPdf(bytes: Uint8Array) {
  if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl)
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' })
  currentPdfUrl = URL.createObjectURL(blob)
  ;(document.getElementById('pdfEmbed') as HTMLIFrameElement).src = currentPdfUrl + '#toolbar=0&zoom=140'
}

// ── Window Management: move popup to second monitor ──────────────────────────────
// Uses chrome.system.display.getInfo() — no user gesture or extra permission needed.
async function moveToSecondScreen() {
  try {
    const displays = await chrome.system.display.getInfo()
    console.log('[FDN RegCard] Displays detected:', displays.map(d =>
      `"${d.name}" primary=${d.isPrimary} workArea=${JSON.stringify(d.workArea)}`
    ))

    const second = displays.find(d => !d.isPrimary) ?? displays[1]
    if (!second) { console.log('[FDN RegCard] Only one display — staying on current screen'); return }

    const win = await chrome.windows.getCurrent()
    if (win.id === undefined) return

    // Nudge onto the target monitor first, then go fullscreen on it
    await chrome.windows.update(win.id, {
      left:  second.workArea.left + 1,
      top:   second.workArea.top  + 1,
      state: 'normal',
    })
    await chrome.windows.update(win.id, { state: 'fullscreen' })
    console.log('[FDN RegCard] Fullscreen on:', second.name, second.workArea)
  } catch (e) {
    console.error('[FDN RegCard] Display detection failed:', e)
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
    const r     = canvas.getBoundingClientRect()
    const src   = 'touches' in e ? e.touches[0] : e
    const scaleX = canvas.width  / r.width
    const scaleY = canvas.height / r.height
    return { x: (src.clientX - r.left) * scaleX, y: (src.clientY - r.top) * scaleY }
  }

  canvas.addEventListener('mousedown',  e => { drawing = true; ctx.beginPath(); const p = getPos(e); ctx.moveTo(p.x, p.y) })
  canvas.addEventListener('mousemove',  e => { if (!drawing) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke() })
  canvas.addEventListener('mouseup',    () => { drawing = false })
  canvas.addEventListener('mouseleave', () => { drawing = false })
  canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing = true; ctx.beginPath(); const p = getPos(e); ctx.moveTo(p.x, p.y) }, { passive: false })
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); if (!drawing) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke() }, { passive: false })
  canvas.addEventListener('touchend',   () => { drawing = false })

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

    const confirmation = document.getElementById('confLabel')?.textContent ?? ''
    try {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon.png'),
        title: 'Guest Signature Complete',
        message: confirmation ? `Confirmation ${confirmation} — guest has signed.` : 'Guest has signed the registration card.',
      })
    } catch (ne) {
      console.warn('[FDN RegCard] Notification failed:', ne)
    }

    window.setTimeout(() => window.close(), 2500)
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
