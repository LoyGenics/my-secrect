function adApplicationId(value, fallback) {
  return /^ca-app-pub-\d{16}~\d{10}$/.test(value || '') ? value : fallback;
}

module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    blockedPermissions: [...(config.android?.blockedPermissions ?? []), 'com.google.android.gms.permission.AD_ID'],
  },
  plugins: [
    ...(config.plugins ?? []),
    ['react-native-google-mobile-ads', {
      androidAppId: adApplicationId(process.env.EXPO_PUBLIC_ADMOB_ANDROID_APP_ID, 'ca-app-pub-3940256099942544~3347511713'),
      iosAppId: adApplicationId(process.env.EXPO_PUBLIC_ADMOB_IOS_APP_ID, 'ca-app-pub-3940256099942544~1458002511'),
      delayAppMeasurementInit: true,
    }],
  ],
});
