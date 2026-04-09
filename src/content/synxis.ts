import { injectFields, type InjectResult } from './inject-helpers'

const SYNXIS_INJECT_SELECTORS: Record<string, string[]> = {
  firstName: ['input[name="firstName"]', 'input[id*="firstName" i]', '#firstName'],
  lastName: ['input[name="lastName"]', 'input[id*="lastName" i]', '#lastName'],
  phone: ['input[name="phone"]', 'input[type="tel"]', 'input[id*="phone" i]'],
  email: ['input[name="email"]', 'input[type="email"]', 'input[id*="email" i]'],
  address: ['input[name="address"]', 'textarea[name="address"]', 'input[id*="address" i]'],
  city: ['input[name="city"]', 'input[id*="city" i]'],
  state: ['input[name="state"]', 'input[id*="state" i]'],
  postalCode: ['input[name="postalCode"]', 'input[name="zip"]', 'input[id*="postal" i]'],
}

chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; fields?: Record<string, string> },
    _sender,
    sendResponse: (r: InjectResult) => void,
  ) => {
    if (message?.type === 'FDN_INJECT' && message.fields) {
      sendResponse(injectFields(SYNXIS_INJECT_SELECTORS, message.fields))
    }
  },
)

export {}
