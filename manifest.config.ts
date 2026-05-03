import { defineManifest } from '@crxjs/vite-plugin'

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
  ],
  web_accessible_resources: [
    {
      resources: ['registration-card.html'],
      matches: ['https://sph.synxis.com/*'],
    },
  ],
  host_permissions: [
    'https://controlcenter-p2.synxis.com/*',
    'https://sph.synxis.com/*',
    'https://live.ipms247.com/*',
    'https://*.ipms247.com/*',
  ],
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

