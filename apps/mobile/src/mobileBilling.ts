import { Platform } from 'react-native';
import type { PurchasesOfferings, PurchasesPackage } from 'react-native-purchases';
import type { MobileBillingState, PurchaseOption } from '../../../packages/sdk/src/billing';
import { HOSTED_API_BASE_URL } from './accountServer';

const purchaseOptions: readonly PurchaseOption[] = ['monthly', 'yearly', 'lifetime'];
type NativePurchases = typeof import('react-native-purchases');

export function storeConfiguration(access: MobileBillingState | undefined, baseUrl: string) {
  if (!access?.app_user_id || !access.store_products) return;
  if (baseUrl !== HOSTED_API_BASE_URL && (!__DEV__ || access.environment !== 'test')) return;
  if (access.environment !== (__DEV__ ? 'test' : 'live')) return;
  const provider = Platform.OS === 'ios' ? 'app_store' : Platform.OS === 'android' ? 'google_play' : undefined;
  if (!provider) return;
  const apiKey = provider === 'app_store' ? process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY : process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;
  const products = access.store_products[provider];
  if (!apiKey?.startsWith(provider === 'app_store' ? 'appl_' : 'goog_') || !products || !Object.keys(products).length) return;
  return { apiKey, appUserId: access.app_user_id, products };
}

type StoreConfiguration = NonNullable<ReturnType<typeof storeConfiguration>>;
export type StorePlan = { option: PurchaseOption; package: PurchasesPackage };

export function availableStorePlans(offerings: PurchasesOfferings, products: StoreConfiguration['products']): StorePlan[] {
  const current = offerings.current;
  if (!current) return [];
  const packages = { monthly: current.monthly, yearly: current.annual, lifetime: current.lifetime };
  return purchaseOptions.flatMap(option => {
    const pack = packages[option];
    if (!pack || !pack.product.priceString || products[pack.product.identifier] !== option) return [];
    // The displayed price is the initial charge. Keep introductory pricing out
    // of this offering until the screen can show its full eligibility and terms.
    const { introPrice, defaultOption } = pack.product;
    if (introPrice || defaultOption?.freePhase || defaultOption?.introPhase) return [];
    return [{ option, package: pack }];
  });
}

// RevenueCat is a process-wide SDK. Serialize native operations so a purchase
// started for one account never runs with the next account's identity.
let storeQueue = Promise.resolve();
function withStore<T>(config: StoreConfiguration, signal: AbortSignal, work: (sdk: NativePurchases) => Promise<T>) {
  const operation = storeQueue.then(async () => {
    if (signal.aborted) throw new Error('billing_session_ended');
    const sdk: NativePurchases = require('react-native-purchases');
    const Purchases = sdk.default;
    if (!await Purchases.isConfigured()) {
      Purchases.configure({
        apiKey: config.apiKey, appUserID: config.appUserId,
        automaticDeviceIdentifierCollectionEnabled: false, diagnosticsEnabled: false,
        shouldShowInAppMessagesAutomatically: false,
      });
    } else if (await Purchases.getAppUserID() !== config.appUserId) {
      await Purchases.logIn(config.appUserId);
    }
    if (signal.aborted) throw new Error('billing_session_ended');
    return work(sdk);
  });
  storeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export function loadStorePlans(config: StoreConfiguration, signal: AbortSignal) {
  return withStore(config, signal, async ({ default: Purchases }) =>
    availableStorePlans(await Purchases.getOfferings(), config.products));
}

export function purchaseStorePlan(config: StoreConfiguration, plan: StorePlan, signal: AbortSignal) {
  return withStore(config, signal, async ({ default: Purchases, PURCHASES_ERROR_CODE }) => {
    try {
      if (config.products[plan.package.product.identifier] !== plan.option) throw new Error('store_product_changed');
      await Purchases.purchasePackage(plan.package);
      return 'submitted' as const;
    } catch (error) {
      const failure = error as { code?: string; userCancelled?: boolean } | null;
      if (failure?.userCancelled || failure?.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) return 'cancelled' as const;
      if (failure?.code === PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR) return 'pending' as const;
      if (failure?.code === PURCHASES_ERROR_CODE.PRODUCT_ALREADY_PURCHASED_ERROR) return 'submitted' as const;
      throw error;
    }
  });
}

export function restoreStorePurchases(config: StoreConfiguration, signal: AbortSignal) {
  return withStore(config, signal, async ({ default: Purchases }) => {
    await Purchases.restorePurchases();
  });
}
