import React, { useEffect, useState } from 'react';
import { Alert, Platform, Text, View, useWindowDimensions } from 'react-native';
import type { AdsConsentInfo } from 'react-native-google-mobile-ads';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { useMobileTheme } from '../theme';
import { space, textStyle } from '../ui/tokens';

type Ads = typeof import('react-native-google-mobile-ads');
type AdsState = { sdk: Ads; consent: AdsConsentInfo };

function bannerUnitId() {
  const appId = Platform.OS === 'ios' ? process.env.EXPO_PUBLIC_ADMOB_IOS_APP_ID : process.env.EXPO_PUBLIC_ADMOB_ANDROID_APP_ID;
  const unitId = Platform.OS === 'ios' ? process.env.EXPO_PUBLIC_ADMOB_IOS_BANNER_ID : process.env.EXPO_PUBLIC_ADMOB_ANDROID_BANNER_ID;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  if (__DEV__) return process.env.EXPO_PUBLIC_ADMOB_TEST_ADS === '1' ? 'test' : undefined;
  if (/^ca-app-pub-\d{16}~\d{10}$/.test(appId ?? '') && /^ca-app-pub-\d{16}\/\d{10}$/.test(unitId ?? '')) return unitId;
}

let consentRequest: Promise<AdsState> | undefined;
let initialization: Promise<unknown> | undefined;

async function getConsent() {
  if (!consentRequest) {
    consentRequest = (async () => {
      const sdk: Ads = require('react-native-google-mobile-ads');
      return { sdk, consent: await sdk.AdsConsent.gatherConsent() };
    })().catch(error => {
      consentRequest = undefined;
      throw error;
    });
  }
  return consentRequest;
}

async function initialize(sdk: Ads) {
  if (!initialization) {
    initialization = (async () => {
      await sdk.default().setRequestConfiguration({ maxAdContentRating: sdk.MaxAdContentRating.G });
      return sdk.default().initialize();
    })().catch(error => {
      initialization = undefined;
      throw error;
    });
  }
  await initialization;
}

export function useVaultBannerAds(eligible: boolean, showVault: boolean) {
  const { t } = useTranslation();
  const [state, setState] = useState<AdsState>();
  const [ready, setReady] = useState(false);
  const unit = bannerUnitId();

  useEffect(() => {
    if (!eligible || !showVault || !unit) return;
    let active = true;
    void getConsent().then(async next => {
      if (!active) return;
      setState(next);
      if (next.consent.canRequestAds) {
        await initialize(next.sdk);
        if (active) setReady(true);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [eligible, showVault, unit]);

  const privacyRequired = state && state.consent.privacyOptionsRequirementStatus === state.sdk.AdsConsentPrivacyOptionsRequirementStatus.REQUIRED;
  async function showPrivacyOptions() {
    if (!state) return;
    try {
      const consent = await state.sdk.AdsConsent.showPrivacyOptionsForm();
      const next = { sdk: state.sdk, consent };
      consentRequest = Promise.resolve(next);
      setState(next);
    } catch {
      Alert.alert(t('mobileBilling.adPrivacy'), t('mobileBilling.adPrivacyError'));
    }
  }

  return {
    banner: eligible && showVault && ready && unit && state?.consent.canRequestAds
      ? { sdk: state.sdk, unitId: unit === 'test' ? state.sdk.TestIds.BANNER : unit }
      : undefined,
    onAdPrivacy: privacyRequired ? showPrivacyOptions : undefined,
  };
}

export function VaultBannerAd({ sdk, unitId }: { sdk: Ads; unitId: string }) {
  const { t } = useTranslation();
  const { colors } = useMobileTheme();
  const { width } = useWindowDimensions();
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (failed || width < 320) return null;
  return <View testID={loaded ? 'free-tier-banner' : undefined} pointerEvents={loaded ? 'auto' : 'none'}
    accessibilityElementsHidden={!loaded} importantForAccessibility={loaded ? 'auto' : 'no-hide-descendants'}
    style={[
      { alignItems: 'center', paddingVertical: space[3], gap: space[1], backgroundColor: colors.canvas },
      !loaded && { position: 'absolute', bottom: 0, left: 0, right: 0, opacity: 0 },
    ]}>
    {loaded && <Text style={[textStyle.caption, { color: colors.secondaryText }]}>{t('mobileBilling.adLabel')}</Text>}
    <sdk.BannerAd unitId={unitId} size={sdk.BannerAdSize.BANNER} requestOptions={{ requestNonPersonalizedAdsOnly: true }}
      onAdLoaded={() => setLoaded(true)} onAdFailedToLoad={() => setFailed(true)} />
  </View>;
}
