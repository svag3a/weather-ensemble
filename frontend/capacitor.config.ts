import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'se.gbgsol.app',
  appName: 'gbgsol',
  webDir: 'dist',
  ios: {
    backgroundColor: '#0f172a',
  },
  plugins: {
    BackgroundGeolocation: {
      // Prompt text shown by iOS when requesting "Always" location permission
      locationAuthorizationDescription:
        'gbgsol använder din position i bakgrunden för att låsa upp platsmärken när du är nära ett Göteborgsmotiv.',
    },
  },
}

export default config
