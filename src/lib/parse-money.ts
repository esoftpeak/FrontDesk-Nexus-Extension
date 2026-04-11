/**
 * Parse PMS currency strings (e.g. "$ 805.00", "805.4", "$1,234.56") to a float for rounding.
 */
export function parseMoneyToNumber(value: string | null | undefined): number | null {
  if (value == null) return null
  const s = String(value)
    .replace(/[$\s\u00a0]/g, '')
    .replace(/,/g, '')
    .replace(/[()]/g, '')
    .trim()
  if (s === '' || s === '-') return null
  const n = Number.parseFloat(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Whole-dollar rounding for DB storage (eZee / FrontDesk rules):
 * - Look at the **first digit after the decimal** (tenths).
 * - Digit 0–4: drop cents (floor to whole dollars).
 * - Digit 6–9: add $1 to whole dollars.
 * - Digit 5 exactly: do **not** add $1 (only “greater than 5” bumps).
 *
 * Examples: $805.00 → 805 | $805.4 → 805 | $805.6 → 806
 */
export function roundWholeDollarsEzee(amount: number): number {
  if (!Number.isFinite(amount)) return 0
  const sign = amount < 0 ? -1 : 1
  const a = Math.abs(amount)
  const intPart = Math.floor(a + 1e-9)
  const frac = a - intPart
  if (frac < 1e-9) return sign * intPart

  const tenthsDigit = Math.floor(frac * 10 + 1e-9)
  let whole = intPart
  if (tenthsDigit < 5) whole = intPart
  else if (tenthsDigit > 5) whole = intPart + 1
  else whole = intPart

  return sign * whole
}

/** Parsed + rounded whole dollars for `total` / `paid` / `balance` DB columns (numeric). */
export function prepareMoneyColumnForDb(raw: string | null | undefined): number | null {
  const n = parseMoneyToNumber(raw)
  if (n == null) return null
  return roundWholeDollarsEzee(n)
}

/** Console-friendly display matching “$ 805” style (space after $). */
export function formatDollarLog(wholeDollars: number | null): string {
  if (wholeDollars == null) return '(null)'
  return `$ ${wholeDollars}`
}
