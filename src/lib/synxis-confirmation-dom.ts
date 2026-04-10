/** SynXis-style confirmation: alphanumeric, 10–16 chars (e.g. 88939EE050317). */
const CONFIRMATION_TOKEN = /^[A-Z0-9]{10,16}$/

/**
 * Guest Stay Record is a SynXis SPA view with no URL change; use stable heading + confirmation cues.
 */
export function isLikelyGuestStayRecordView(doc: Document): boolean {
  const body = doc.body
  if (!body) return false
  const text = body.innerText ?? ''
  if (!text.includes('Guest Stay Record')) return false
  if (!text.includes('Confirmation')) return false
  return true
}

function extractFromConfirmationLabel(doc: Document): string | null {
  const body = doc.body
  if (!body) return null

  const labelPatterns: RegExp[] = [
    /Confirmation\s*#\s*:\s*([A-Z0-9]{10,16})/i,
    /Confirmation\s*Number\s*[:.]?\s*([A-Z0-9]{10,16})/i,
  ]

  const haystack = body.innerText ?? ''
  for (const re of labelPatterns) {
    const m = haystack.match(re)
    if (m?.[1] && CONFIRMATION_TOKEN.test(m[1].toUpperCase())) {
      return m[1].toUpperCase()
    }
  }

  const elements = body.querySelectorAll<HTMLElement>('*')
  for (const el of elements) {
    const text = el.innerText ?? el.textContent ?? ''
    if (!text.includes('Confirmation')) continue
    const compact = text.replace(/\s+/g, ' ').trim()
    for (const re of labelPatterns) {
      const m = compact.match(re)
      if (m?.[1] && CONFIRMATION_TOKEN.test(m[1].toUpperCase())) {
        return m[1].toUpperCase()
      }
    }
  }

  return null
}

function extractByRegexScan(doc: Document): string | null {
  const body = doc.body
  if (!body) return null

  const scored: { value: string; score: number }[] = []
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const t = node.textContent ?? ''
      return t.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    },
  })

  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    const raw = node.textContent ?? ''
    for (const match of raw.matchAll(/\b([A-Za-z0-9]{10,16})\b/g)) {
      const upper = match[1].toUpperCase()
      if (!CONFIRMATION_TOKEN.test(upper)) continue
      let score = 0
      const parent = node.parentElement
      const ctx = (parent?.innerText ?? raw).toLowerCase()
      if (ctx.includes('confirmation')) score += 10
      if (ctx.includes('reservation')) score += 3
      if (ctx.includes('stay')) score += 1
      scored.push({ value: upper, score })
    }
  }

  if (scored.length === 0) return null
  scored.sort((a, b) => b.score - a.score)
  return scored[0].value
}

export function extractConfirmationFromDocument(doc: Document): string | null {
  return extractFromConfirmationLabel(doc) ?? extractByRegexScan(doc)
}

export function isSynxisConfirmationToken(s: string): boolean {
  return CONFIRMATION_TOKEN.test(s.trim().toUpperCase())
}
