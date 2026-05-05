import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

// Signature overlay position for Synxis PDF (points, origin = bottom-left)
const SIG_X = 140
const SIG_Y = 310
const SIG_W = 200
const SIG_H = 40

type RegCardData =
  | { pdfBase64: string; confirmation: string }
  | { ezeeReportUrl: string; confirmation: string }

let currentPdfBytes: Uint8Array | null = null
let currentPdfUrl: string | null = null
let isEzeeMode = false

async function init() {
  const result = await chrome.storage.local.get('regCardData') as { regCardData?: RegCardData }
  const data = result.regCardData
  if (!data) {
    document.body.innerHTML = '<p style="padding:2rem;color:red;font-family:sans-serif">No registration card data found. Please close this window and try again.</p>'
    return
  }

  document.getElementById('confLabel')!.textContent = data.confirmation

  if ('ezeeReportUrl' in data) {
    // eZee mode: load Stimulsoft report URL directly in the iframe
    isEzeeMode = true
    ;(document.getElementById('pdfEmbed') as HTMLIFrameElement).src = data.ezeeReportUrl
    setupSignatureCanvas()
    window.setTimeout(() => {
      document.getElementById('signModal')!.classList.add('open')
    }, 2000)
    await moveToSecondScreen()
    return
  }

  // Synxis mode: decode base64 PDF and display
  isEzeeMode = false
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
  ;(document.getElementById('pdfEmbed') as HTMLIFrameElement).src = currentPdfUrl + '#zoom=140'
}

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

    await chrome.windows.update(win.id, {
      left:   second.workArea.left,
      top:    second.workArea.top,
      width:  second.workArea.width,
      height: second.workArea.height,
      state:  'normal',
    })
    console.log('[FDN RegCard] Moved to:', second.name, second.workArea)
  } catch (e) {
    console.error('[FDN RegCard] Display detection failed:', e)
  }
}

function setupSignatureCanvas() {
  const canvas = document.getElementById('sigCanvas')  as HTMLCanvasElement
  const modal  = document.getElementById('signModal')  as HTMLDivElement
  const status = document.getElementById('sigStatus')  as HTMLParagraphElement
  const ctx    = canvas.getContext('2d')!

  ctx.strokeStyle = '#1a237e'
  ctx.lineWidth   = 2
  ctx.lineCap     = 'round'
  ctx.lineJoin    = 'round'

  let drawing = false

  function getPos(e: MouseEvent | TouchEvent) {
    const r      = canvas.getBoundingClientRect()
    const src    = 'touches' in e ? e.touches[0] : e
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
  document.getElementById('btnSave')!.onclick   = () => void embedSignature(canvas, modal, status)
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

async function embedSignature(canvas: HTMLCanvasElement, modal: HTMLElement, status: HTMLElement) {
  const btn = document.getElementById('btnSave') as HTMLButtonElement
  btn.disabled = true
  btn.textContent = 'Saving…'

  try {
    const pngDataUrl = canvas.toDataURL('image/png')
    let savedBytes: Uint8Array

    if (isEzeeMode) {
      // eZee mode: build a signature-record PDF from scratch
      const pdfDoc = await PDFDocument.create()
      const font   = await pdfDoc.embedFont(StandardFonts.Helvetica)
      const bold   = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
      const page   = pdfDoc.addPage([612, 792])
      const { height } = page.getSize()
      const conf   = document.getElementById('confLabel')?.textContent?.trim() ?? ''

      page.drawText('Guest Registration Card — Signature Record', {
        x: 50, y: height - 60, size: 14, font: bold, color: rgb(0.08, 0.28, 0.56),
      })
      page.drawText(`Confirmation: ${conf}`, {
        x: 50, y: height - 86, size: 11, font, color: rgb(0.2, 0.2, 0.2),
      })
      page.drawText(`Signed: ${new Date().toLocaleString()}`, {
        x: 50, y: height - 106, size: 10, font, color: rgb(0.45, 0.45, 0.45),
      })
      page.drawLine({
        start: { x: 50, y: height - 124 }, end: { x: 562, y: height - 124 },
        thickness: 0.5, color: rgb(0.75, 0.75, 0.75),
      })
      page.drawText('Guest Signature:', {
        x: 50, y: height - 152, size: 11, font, color: rgb(0.2, 0.2, 0.2),
      })
      const pngImage = await pdfDoc.embedPng(pngDataUrl)
      page.drawImage(pngImage, { x: 50, y: height - 270, width: 350, height: 90 })
      page.drawLine({
        start: { x: 50, y: height - 276 }, end: { x: 400, y: height - 276 },
        thickness: 0.5, color: rgb(0.3, 0.3, 0.3),
      })

      savedBytes = await pdfDoc.save()
    } else {
      // Synxis mode: overlay signature PNG on the existing registration card PDF
      if (!currentPdfBytes) return
      const pdfDoc   = await PDFDocument.load(currentPdfBytes)
      const pngImage = await pdfDoc.embedPng(pngDataUrl)
      const page     = pdfDoc.getPages()[0]
      page.drawImage(pngImage, { x: SIG_X, y: SIG_Y, width: SIG_W, height: SIG_H })
      savedBytes = await pdfDoc.save()
      currentPdfBytes = savedBytes
      showPdf(savedBytes)
      console.log('[FDN RegCard] Signature embedded into PDF ✓ (x=%d y=%d w=%d h=%d)', SIG_X, SIG_Y, SIG_W, SIG_H)
    }

    modal.classList.remove('open')

    const confirmation = document.getElementById('confLabel')?.textContent?.trim() ?? ''
    console.log('[FDN RegCard] Signature captured ✓ | mode:', isEzeeMode ? 'eZee' : 'Synxis')

    status.textContent = 'Saving to cloud…'
    status.className = 'status'

    let cloudOk = false
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'SAVE_SIGNATURE',
        pdfBase64: uint8ToBase64(savedBytes),
        confirmationNumber: confirmation,
      })
      cloudOk = result?.ok === true
      if (!cloudOk) console.warn('[FDN RegCard] Cloud save failed:', result?.error)
    } catch (msgErr) {
      console.warn('[FDN RegCard] Could not reach service worker:', msgErr)
    }

    status.textContent = cloudOk ? '✓ Signature saved to cloud' : '✓ Signed — cloud save failed (check console)'
    status.className   = cloudOk ? 'status ok' : 'status warn'

    try {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon.png'),
        title: 'Guest Signature Complete',
        message: confirmation
          ? `Confirmation ${confirmation} — guest has signed.`
          : 'Guest has signed the registration card.',
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
