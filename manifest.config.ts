import { defineManifest } from '@crxjs/vite-plugin'

/** `https://host/*` required by Chrome; normalizes `https://host` or `https://host/`. */
function normalizeExternMatch(entry: string): string {
  const s = entry.trim()
  if (!s) return ''
  if (s.endsWith('/*')) return s
  const base = s.replace(/\/+$/, '')
  return `${base}/*`
}

/** Production portal(s) always allowed — avoids empty `externally_connectable` when CI omits extension `.env`. */
const DEFAULT_PORTAL_EXTERN_MATCHES = ['https://front-desk-nexus.vercel.app/*'] as const

/** Comma-separated patterns (build-time). Merged with defaults. See extension `.env.example`. */
const extraPortalMatches = (process.env.VITE_PORTAL_EXTERN_MATCHES ?? '')
  .split(',')
  .map((s) => normalizeExternMatch(s))
  .filter(Boolean)

const externallyConnectableMatches = [
  ...new Set<string>([
    'http://localhost:5173/*',
    'http://127.0.0.1:5173/*',
    ...DEFAULT_PORTAL_EXTERN_MATCHES,
    ...extraPortalMatches,
  ]),
]

export default defineManifest({
  manifest_version: 3,
  name: 'FrontDesk Nexus',
  version: '1.0.0',
  action: {
    default_title: 'FrontDesk',
  },
  side_panel: {
    default_path: 'index.html',
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  permissions: [
    'storage',
    'activeTab',
    'scripting',
    'sidePanel',
    'nativeMessaging',
    'notifications',
    'cookies',
    'windowManagement',
    'windows',
    'system.display',
    'debugger',
  ],
  web_accessible_resources: [
    {
      resources: ['registration-card.html'],
      matches: ['https://sph.synxis.com/*'],
    },
    {
      resources: ['registration-card.html'],
      matches: ['https://live.ipms247.com/*', 'https://*.ipms247.com/*'],
    },
  ],
  host_permissions: [
    'https://controlcenter-p2.synxis.com/*',
    'https://sph.synxis.com/*',
    'https://live.ipms247.com/*',
    'https://*.ipms247.com/*',
    'https://api.zippopotam.us/*',
  ],
  externally_connectable: {
    matches: externallyConnectableMatches,
  },
  content_scripts: [
    {
      matches: ['https://sph.synxis.com/*'],
      js: ['src/content/synxis-sph-autoload.ts'],
      // Guest Stay Record runs inside an iframe; default all_frames=false only injects the tab top frame.
      all_frames: true,
    },
    {
      matches: ['https://controlcenter-p2.synxis.com/*'],
      js: ['src/content/synxis.ts'],
    },
    {
      matches: ['https://live.ipms247.com/*', 'https://*.ipms247.com/*'],
      js: ['src/content/ezee.ts'],
    },
  ],
})

