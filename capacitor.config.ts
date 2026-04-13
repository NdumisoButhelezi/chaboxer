import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.chaboxer.app',
  appName: 'chaboxer',
  webDir: 'dist',
  android: {
    backgroundColor: '#0f172a'
  },
  ios: {
    contentInset: 'automatic'
  }
};

export default config;
