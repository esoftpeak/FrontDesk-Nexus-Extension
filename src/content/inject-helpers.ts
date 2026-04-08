/**
 * Try several selectors; set value and dispatch input/change for React-controlled fields.
 */
export function setInputValue(selectors: string[], value: string): boolean {
  for (const sel of selectors) {
    const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null
    if (!el) continue
    el.focus()
    el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  return false
}

export type InjectResult = { ok: true; applied: string[] } | { ok: false; error: string }

export function injectFields(
  fieldSelectors: Record<string, string[]>,
  fields: Record<string, string>,
): InjectResult {
  const applied: string[] = []
  try {
    for (const [key, val] of Object.entries(fields)) {
      if (!val) continue
      const sels = fieldSelectors[key]
      if (!sels) continue
      if (setInputValue(sels, val)) applied.push(key)
    }
    if (applied.length === 0) {
      return {
        ok: false,
        error: 'No matching PMS form fields found (selectors may need updating for this site).',
      }
    }
    return { ok: true, applied }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Inject failed',
    }
  }
}
