/**
 * Injected into SynXis tabs via chrome.scripting.executeScript (allFrames).
 * Must stay self-contained — no imports — so the function serializes for injection.
 */
export function synxisExtractInFrame(): { value: string | null; href: string } {
  const CONFIRMATION_TOKEN = /^[A-Z0-9]{10,16}$/

  function extractFromConfirmationLabel(): string | null {
    const body = document.body
    if (!body) return null

    const labelPatterns: RegExp[] = [
      /Confirmation\s*#\s*:\s*([A-Z0-9]{10,16})/i,
      /Confirmation\s+Number\s*[:.]?\s*([A-Z0-9]{10,16})/i,
    ]

    const haystack = body.innerText ?? ''
    for (const re of labelPatterns) {
      const m = haystack.match(re)
      if (m?.[1] && CONFIRMATION_TOKEN.test(m[1].toUpperCase())) {
        return m[1].toUpperCase()
      }
    }

    const elements = body.querySelectorAll('*')
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i] as HTMLElement
      const text = el.innerText ?? el.textContent ?? ''
      if (!text.includes('Confirmation')) continue
      const compact = text.replace(/\s+/g, ' ').trim()
      for (let j = 0; j < labelPatterns.length; j++) {
        const m = compact.match(labelPatterns[j])
        if (m?.[1] && CONFIRMATION_TOKEN.test(m[1].toUpperCase())) {
          return m[1].toUpperCase()
        }
      }
    }

    return null
  }

  function extractByRegexScan(): string | null {
    const body = document.body
    if (!body) return null

    const scored: { value: string; score: number }[] = []
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node) {
        const t = node.textContent ?? ''
        return t.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
      },
    })

    let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
      const raw = node.textContent ?? ''
      const matches = raw.matchAll(/\b([A-Za-z0-9]{10,16})\b/g)
      for (const match of matches) {
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

  const value = extractFromConfirmationLabel() ?? extractByRegexScan()
  const href = typeof location !== 'undefined' ? location.href : ''
  return { value, href }
}
