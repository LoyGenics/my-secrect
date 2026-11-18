module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    blockedPermissions: [...(config.android?.blockedPermissions ?? []), 'com.google.android.gms.permission.AD_ID'],
  },
  plugins: [
    ...(config.plugins ?? []),
    ['react-native-google-mobile-ads', {
      androidAppId: process.env.EXPO_PUBLIC_ADMOB_ANDROID_APP_ID || 'ca-app-pub-3940256099942544~3347511713',
      iosAppId: process.env.EXPO_PUBLIC_ADMOB_IOS_APP_ID || 'ca-app-pub-3940256099942544~1458002511',
      delayAppMeasurementInit: true,
    }],
  ],
});
