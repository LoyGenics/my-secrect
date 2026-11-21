import React, { useMemo, useState } from 'react';
import { Alert, FlatList, Platform, Text, View, useWindowDimensions } from 'react-native';
import { NavigationContainer, DarkTheme, DefaultTheme, StackActions, useIsFocused, usePreventRemove, type NavigationAction } from '@react-navigation/native';
import { createNativeStackNavigator, type NativeStackNavigationOptions, type NativeStackNavigationProp, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Icon, illustrations, type NativeIconName } from '../../../packages/ui/src/native';
import type { ItemType, VaultItem } from '../../../packages/core/src/types';
import { isFile, isFileFolder } from '../../../packages/core/src/files';
import { useTranslation } from '../../../packages/i18n/src/react';
import { useMobileTheme } from './theme';
import { AppPage, BottomSheet, EmptyState, Group, IconButton, Rule, SettingsRow, Toast } from './components/mobile-ui';
import ItemRow from './components/ItemRow';
import { FloatingDock, type DockTab } from './components/FloatingDock';
import { Avatar, Cover, useAccountEmail } from './components/ledger';
import VaultScreen from './screens/VaultScreen';
import SearchScreen from './screens/SearchScreen';
import GeneratorScreen from './screens/GeneratorScreen';
import HealthScreen from './screens/HealthScreen';
import SettingsScreen, { AppearanceScreen } from './screens/SettingsScreen';
import SecurityScreen, { getApiToken } from './screens/SecurityScreen';
import ImportItemsScreen from './screens/ImportItemsScreen';
import ItemDetailScreen from './screens/ItemDetailScreen';
import ItemFormScreen from './screens/ItemFormScreen';
import ItemTemplateScreen from './screens/ItemTemplateScreen';
import TrashScreen from './screens/TrashScreen';
import FamilyScreen from './screens/FamilyScreen';
import SharesScreen from './screens/SharesScreen';
import FilesScreen, { FilePreviewScreen, type FilePickerKind } from './screens/FilesScreen';
import ShareLinkScreen from './screens/ShareLinkScreen';
import BillingScreen from './screens/BillingScreen';
import { useVaultBannerAds, VaultBannerAd } from './components/VaultBannerAd';
import type { MobileBilling } from './useMobileBilling';
import { clearVaultFilters, createVaultFilter, type VaultFilter } from './utils/vaultFilter';
import { getPageGutter, size, space, textStyle } from './ui/tokens';
import type { AutoLockMinutes } from './ui/preferences';
import { useReducedMotion } from './ui/motion';

type SearchContext = 'vault' | 'archive' | 'global';
type Routes = {
  Home: undefined;
  Search: { context: SearchContext };
  Detail: { id: string };
  Templates: undefined;
  Form: { id: string } | { template: ItemType };
  Folder: { id: string };
  Collection: { id: string };
  File: { id: string };
  ImportFiles: { picker: FilePickerKind };
  ImportItems: undefined;
  ShareLink: { id: string };
  Trash: undefined;
  Archive: undefined;
  Appearance: undefined;
  Security: undefined;
  Billing: undefined;
  Family: undefined;
  Shares: undefined;
};
type Navigation = NativeStackNavigationProp<Routes>;
const Stack = createNativeStackNavigator<Routes>();
const Tabs = createBottomTabNavigator();

export interface MobileNavigationProps {
  items: VaultItem[];
  trash: VaultItem[];
  autoLock: AutoLockMinutes;
  notice: string;
  onSave: (item: VaultItem, localCardCode?: string) => Promise<void>;
  onImportItems: (items: VaultItem[]) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onToggleFavorite: (id: string) => void;
  onLoadExamples: (items: VaultItem[]) => void;
  onClearExamples: (ids: string[]) => void;
  onAutoLockChange: (minutes: AutoLockMinutes) => void;
  onLock: () => void;
  onWiped: () => void;
  setNotice: (notice: string) => void;
  apiBaseUrl: string;
  billing: MobileBilling;
  initialShareItemId?: string;
  onSignedOut: () => void;
  onUnauthorized: (shareItemId?: string) => void;
  onServerSaved: (url: string) => void;
}

function openItem(navigation: Navigation, item: VaultItem | undefined, id: string, push = false) {
  const target = item && isFile(item) ? 'File' : item && isFileFolder(item) ? 'Folder' : 'Detail';
  if (push) navigation.push(target, { id });
  else navigation.navigate(target, { id });
}

function ScreenHeaderAction({ icon, label, testID, onPress }: {
  icon: NativeIconName; label: string; testID: string; onPress: () => void;
}) {
  return <IconButton icon={icon} tone="link" accessibilityLabel={label} testID={testID} onPress={onPress} />;
}

function FormRoute({ navigation, route, data }: NativeStackScreenProps<Routes, 'Form'> & { data: MobileNavigationProps }) {
  const { dict, t } = useTranslation();
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<NavigationAction | null>(null);
  const itemId = 'id' in route.params ? route.params.id : undefined;
  const initial = itemId ? data.items.find(item => item.id === itemId) : undefined;
  const template = 'template' in route.params ? route.params.template : undefined;
  usePreventRemove(dirty, ({ data: event }) => Alert.alert(t('mobileUI.discardTitle'), t('mobileUI.discardBody'), [
    { text: t('mobileUI.keepEditing'), style: 'cancel' },
    { text: t('mobileUI.discard'), style: 'destructive', onPress: () => { setDirty(false); setPending(event.action); } },
  ]));
  React.useEffect(() => {
    if (pending && !dirty) { navigation.dispatch(pending); setPending(null); }
  }, [pending, dirty, navigation]);

  if ('id' in route.params && !initial) {
    return <AppPage><EmptyState title={t('mobileUI.notFound')} /></AppPage>;
  }

  return (
    <ItemFormScreen
      initial={initial}
      template={template}
      allItems={data.items}
      onDirtyChange={setDirty}
      onTypeChange={(type: ItemType) => navigation.setOptions({ title: initial ? t('mobileUI.editFormTitle', dict.itemTypes[type]) : dict.mobileEditor.newTemplates[type] })}
      onSave={async (item, localCardCode) => {
        await data.onSave(item, localCardCode);
        const state = navigation.getState();
        const previous = state.routes[state.index - 1];
        const returnsToDetail = previous?.name === 'Detail' && (previous.params as Routes['Detail'])?.id === item.id;
        setDirty(false);
        setPending(returnsToDetail ? StackActions.pop() : StackActions.replace('Detail', { id: item.id }));
      }}
    />
  );
}

function AppNotice({ data }: { data: MobileNavigationProps }) {
  const { dict } = useTranslation();
  const { width } = useWindowDimensions();
  if (!data.notice) return null;
  const gutter = getPageGutter(width);
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', bottom: space[3], left: gutter, right: gutter, alignItems: 'center' }}>
      <View style={{ width: '100%', maxWidth: size.formWidth }}>
        <Toast testID="app-notice" message={data.notice} dismissLabel={dict.mobile.dismissNotice} onDismiss={() => data.setNotice('')} />
      </View>
    </View>
  );
}

function MainTabs({ data, navigation, filter, onFilterChange }: {
  data: MobileNavigationProps; navigation: Navigation; filter: VaultFilter; onFilterChange: (filter: VaultFilter) => void;
}) {
  const { dict, t } = useTranslation();
  const { colors } = useMobileTheme();
  const expanded = useWindowDimensions().width >= size.navigationRailBreakpoint;
  const dock = dict.mobileVault.dock;
  const entries = [
    { key: 'vault', title: dict.shell.tabs.vault, label: dock.vault, icon: 'lock' },
    { key: 'files', title: t('mobileUI.files'), label: dock.files, icon: 'collections' },
    { key: 'generator', title: dict.shell.tabs.generator, label: dock.generate, icon: 'generate' },
    { key: 'health', title: t('mobileUI.healthTab'), label: dock.health, icon: 'shield' },
    { key: 'settings', title: dict.shell.tabs.settings, label: dock.settings, icon: 'settings' },
  ] as const satisfies readonly (DockTab & { title: string })[];
  const [active, setActive] = useState<(typeof entries)[number]['key']>('vault');
  const [account, setAccount] = useState(false);
  const email = useAccountEmail();
  const homeFocused = useIsFocused();
  const { banner, onAdPrivacy } = useVaultBannerAds(data.billing.access?.tier === 'free', homeFocused && active === 'vault');
  const newItem = () => navigation.navigate('Templates');
  const search = (context: SearchContext) => navigation.navigate('Search', { context });
  const open = (screen: 'Security' | 'Shares' | 'Family') => navigation.navigate(screen);
  const select = (id: string) => openItem(navigation, data.items.find(item => item.id === id), id);
  const archive = () => navigation.navigate('Archive');
  const trash = () => navigation.navigate('Trash');

  return (
    <>
      <Tabs.Navigator
        tabBar={expanded ? undefined : props => <FloatingDock {...props} tabs={entries} searchRoute="search" />}
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.plum,
          tabBarActiveBackgroundColor: expanded ? colors.selection : undefined,
          tabBarInactiveTintColor: colors.secondaryText,
          tabBarStyle: {
            backgroundColor: colors.surface, borderTopColor: colors.border,
            width: expanded ? size.navigationRailWidth : undefined,
            minWidth: expanded ? size.navigationRailWidth : undefined,
          },
          tabBarLabelStyle: textStyle.micro,
          tabBarAllowFontScaling: expanded || undefined,
          tabBarPosition: expanded ? 'left' : 'bottom',
          tabBarVariant: expanded && Platform.OS === 'android' ? 'material' : 'uikit',
          tabBarHideOnKeyboard: true,
          sceneStyle: { backgroundColor: colors.canvas },
        }}>
        {entries.map(entry => (
          <Tabs.Screen key={entry.key} name={entry.key}
            options={{ title: entry.title, tabBarLabel: entry.label, tabBarAccessibilityLabel: entry.title, tabBarButtonTestID: `tab-${entry.key}`, tabBarIcon: ({ color }) => <Icon name={entry.icon} color={color} size={size.tabIcon} /> }}
            listeners={{ focus: () => setActive(entry.key) }}>
            {() => (
              <View style={{ flex: 1 }}>
                {entry.key === 'vault' ? <>
                  <VaultScreen {...data} filter={filter} onFilterChange={onFilterChange} onSelect={select} onNew={newItem}
                    onSearch={Platform.OS === 'android' || expanded ? () => search('vault') : undefined} onOpen={open} onViewArchive={archive} onViewTrash={trash}
                    title={entry.title} accountEmail={email} onAccount={() => setAccount(true)} />
                  {banner && <VaultBannerAd {...banner} />}
                </> : <>
                  <Cover title={entry.title} titleTestID={`cover-title-${entry.key}`}>
                    {entry.key === 'settings' && <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
                      <Avatar email={email} large />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[textStyle.strong, { color: colors.onCover }]} numberOfLines={1}>{dict.mobileVault.signedIn}</Text>
                        {!!email && <Text style={[textStyle.caption, { color: colors.onCoverSecondary }]} numberOfLines={1}>{email}</Text>}
                      </View>
                    </View>}
                  </Cover>
                  {entry.key === 'files' && <FilesScreen items={data.items} onSave={data.onSave} onDelete={data.onDelete} onOpenFolder={id => navigation.navigate('Folder', { id })} onOpenFile={id => navigation.navigate('File', { id })} />}
                  {entry.key === 'generator' && <GeneratorScreen />}
                  {entry.key === 'health' && <HealthScreen items={data.items} onFix={item => navigation.navigate('Form', { id: item.id })} />}
                  {entry.key === 'settings' && <SettingsScreen {...data} onViewTrash={trash} onViewArchive={archive} onViewSecurity={() => open('Security')} onOpen={open} onAppearance={() => navigation.navigate('Appearance')} onImportItems={() => navigation.navigate('ImportItems')}
                    onBilling={() => navigation.navigate('Billing')} onAdPrivacy={onAdPrivacy} />}
                </>}
                <AppNotice data={data} />
              </View>
            )}
          </Tabs.Screen>
        ))}
        <Tabs.Screen name="search" options={{ title: dict.search.title, tabBarButton: () => null, tabBarItemStyle: { display: 'none' } }}>
          {() => <View style={{ flex: 1 }}>
            <SearchScreen items={data.items} title={dict.search.title} onNew={newItem} onSelect={select} />
          </View>}
        </Tabs.Screen>
      </Tabs.Navigator>
      <BottomSheet compact visible={account} title={dict.mobileVault.account} testID="account-sheet" onClose={() => setAccount(false)}>
        <Group>
          {!!email && <><SettingsRow label={email} icon="person" /><Rule leading /></>}
          <SettingsRow testID="account-settings" label={dict.shell.tabs.settings} icon="settings" navigation
            onPress={() => { setAccount(false); navigation.navigate('Home', { screen: 'settings' } as never); }} />
          <Rule leading />
          <SettingsRow testID="account-lock" label={t('mobileUI.lockNow')} icon="lock" onPress={() => { setAccount(false); data.onLock(); }} />
        </Group>
      </BottomSheet>
    </>
  );
}

export default function MobileNavigator(data: MobileNavigationProps) {
  const { colors, scheme } = useMobileTheme();
  const { dict, t } = useTranslation();
  const [filter, setFilter] = useState(createVaultFilter);
  const [archiveFilter, setArchiveFilter] = useState(createVaultFilter);
  const reducedMotion = useReducedMotion();
  const theme = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return { ...base, colors: { ...base.colors, primary: colors.primaryTextLink, background: colors.canvas, card: colors.surface, text: colors.text, border: colors.border, notification: colors.danger } };
  }, [colors, scheme]);
  const findLive = (id: string) => data.items.find(item => item.id === id);
  const find = (id: string) => findLive(id) ?? data.trash.find(item => item.id === id);
  const shareItem = data.initialShareItemId ? findLive(data.initialShareItemId) : undefined;
  // Details, filters and New item are sheets over the ledger (iOS form sheet with a grabber); Android slides up a modal.
  const sheet: NativeStackNavigationOptions = {
    headerShown: false,
    presentation: Platform.OS === 'ios' ? 'formSheet' : 'modal',
    sheetAllowedDetents: [0.94],
    sheetGrabberVisible: true,
    sheetCornerRadius: 20,
    contentStyle: { backgroundColor: colors.surface },
  };

  return (
    <NavigationContainer theme={theme} initialState={shareItem ? {
      index: 2,
      routes: [
        { name: 'Home' },
        { name: 'Detail', params: { id: shareItem.id } },
        { name: 'ShareLink', params: { id: shareItem.id } },
      ],
    } : undefined}>
      <Stack.Navigator screenOptions={({ navigation }) => ({
        // Pushed screens keep the cover band as their header.
        headerStyle: { backgroundColor: colors.cover },
        headerTitleStyle: textStyle.strong,
        headerTintColor: colors.onCover,
        headerTitle: ({ children }) => <Text accessibilityRole="header" style={[textStyle.strong, { color: colors.onCover }]} numberOfLines={1}>{children}</Text>,
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        ...(Platform.OS === 'android' && { statusBarStyle: scheme === 'light' ? 'dark' : 'light' }),
        headerRight: () => <ScreenHeaderAction icon="search" label={t('mobileUI.searchAll')} testID="header-global-search" onPress={() => navigation.navigate('Search', { context: 'global' })} />,
        contentStyle: { backgroundColor: colors.canvas },
        animation: reducedMotion ? 'none' : 'default',
      })}>
        <Stack.Screen name="Home" options={{ title: dict.shell.tabs.vault, headerShown: false }}>
          {props => <MainTabs {...props} data={data} filter={filter} onFilterChange={setFilter} />}
        </Stack.Screen>
        <Stack.Screen name="Search" options={({ navigation }) => ({
          title: dict.search.title, presentation: 'modal', headerBackVisible: false,
          headerRight: () => <ScreenHeaderAction icon="close" label={dict.common.close} testID="search-close" onPress={() => navigation.goBack()} />,
        })}>
          {({ navigation, route }) => {
            const { context } = route.params;
            const archived = context === 'archive';
            const active = archived ? archiveFilter : filter;
            const setActive = archived ? setArchiveFilter : setFilter;
            return <SearchScreen items={data.items} archived={archived}
              filter={context === 'global' ? undefined : active}
              onClearFilters={context === 'global' ? undefined : () => setActive(clearVaultFilters(active))}
              onSelect={id => openItem(navigation, findLive(id), id, true)} />;
          }}
        </Stack.Screen>
        <Stack.Screen name="Templates" options={{ title: dict.mobileEditor.templatesTitle, headerRight: () => null, ...sheet }}>
          {({ navigation }) => <ItemTemplateScreen onClose={() => navigation.goBack()} onSelect={template => navigation.replace('Form', { template })} onImport={picker => navigation.replace('ImportFiles', { picker })} />}
        </Stack.Screen>
        <Stack.Screen name="ImportItems" options={{ title: dict.itemImport.title, headerRight: () => null }}>
          {() => <ImportItemsScreen items={data.items} apiBaseUrl={data.apiBaseUrl}
            getToken={getApiToken} onImport={data.onImportItems}
            onUnauthorized={data.onUnauthorized} />}
        </Stack.Screen>
        <Stack.Screen name="Form" options={({ route, navigation }) => ({
          title: 'id' in route.params ? t('mobileUI.editFormTitle', dict.itemTypes[findLive(route.params.id)?.type ?? 'custom']) : dict.mobileEditor.newTemplates[route.params.template],
          presentation: Platform.OS === 'ios' ? 'fullScreenModal' : 'modal',
          headerBackVisible: false,
          headerTitleAlign: 'center',
          headerStyle: { backgroundColor: colors.canvas },
          headerShadowVisible: true,
          headerTitle: ({ children }) => <Text accessibilityRole="header" style={[textStyle.strong, { color: colors.text }]} numberOfLines={1}>{children}</Text>,
          headerLeft: () => <ScreenHeaderAction icon="close" label={dict.common.close} testID="form-close" onPress={() => navigation.goBack()} />,
          headerRight: () => null,
        })}>
          {props => <FormRoute {...props} data={data} />}
        </Stack.Screen>
        <Stack.Screen name="Detail" options={({ route }) => {
          const type = find(route.params.id)?.type;
          return { title: type ? dict.itemTypes[type] : t('mobileUI.viewItem'), ...sheet };
        }}>
          {({ navigation, route }) => {
            const item = find(route.params.id);
            if (!item) return <AppPage><EmptyState title={t('mobileUI.notFound')} /></AppPage>;
            return <ItemDetailScreen item={item} allItems={data.items} inTrash={data.trash.some(value => value.id === item.id)} onClose={() => navigation.goBack()}
              onShare={() => navigation.navigate('ShareLink', { id: item.id })}
              onSelectRelated={id => openItem(navigation, findLive(id), id, true)}
              onOpenCollection={() => navigation.push('Collection', { id: item.id })}
              onOpenFile={() => navigation.push('File', { id: item.id })}
              onEdit={() => navigation.navigate('Form', { id: item.id })}
              onDelete={async () => { await data.onDelete(item.id); navigation.goBack(); }}
              onRestore={() => data.onRestore(item.id)}
              onToggleFavorite={() => data.onToggleFavorite(item.id)} />;
          }}
        </Stack.Screen>
        <Stack.Screen name="ShareLink" options={({ navigation }) => ({
          title: t('mobileUI.shareLink'), presentation: 'modal', headerBackVisible: false,
          headerRight: () => <ScreenHeaderAction icon="close" label={dict.common.close} testID="share-link-close" onPress={() => navigation.goBack()} />,
        })}>
          {({ route }) => {
            const item = findLive(route.params.id);
            return item ? <ShareLinkScreen item={item} baseUrl={data.apiBaseUrl} onUnauthorized={data.onUnauthorized} /> : <AppPage><EmptyState title={t('mobileUI.notFound')} /></AppPage>;
          }}
        </Stack.Screen>
        <Stack.Screen name="Archive" options={{ title: dict.shell.archived, headerShown: false }}>
          {({ navigation }) => <VaultScreen {...data} filter={archiveFilter} onFilterChange={setArchiveFilter} mode="archive" title={dict.shell.archived} onBack={() => navigation.goBack()}
            onSelect={id => openItem(navigation, findLive(id), id)} onNew={() => navigation.navigate('Templates')}
            onSearch={() => navigation.navigate('Search', { context: 'archive' })} onViewTrash={() => navigation.navigate('Trash')} />}
        </Stack.Screen>
        <Stack.Screen name="Trash" options={{ title: dict.shell.trash }}>
          {({ navigation }) => <TrashScreen trash={data.trash} onSelect={id => navigation.navigate('Detail', { id })}
            onRestore={id => void data.onRestore(id)} onPermanentDelete={id => void data.onDelete(id)} />}
        </Stack.Screen>
        <Stack.Screen name="Appearance" options={{ title: dict.theme.label, headerRight: () => null }}>{() => <AppearanceScreen />}</Stack.Screen>
        <Stack.Screen name="Security" options={{ title: dict.security.title }}>
          {({ navigation }) => <SecurityScreen baseUrl={data.apiBaseUrl} onClose={() => navigation.goBack()} onSignedOut={data.onSignedOut} onUnauthorized={data.onUnauthorized} />}
        </Stack.Screen>
        <Stack.Screen name="Billing" options={{ title: dict.billing.title, headerRight: () => null }}>
          {() => <BillingScreen billing={data.billing} baseUrl={data.apiBaseUrl} />}
        </Stack.Screen>
        <Stack.Screen name="Shares" options={{ title: dict.shares.title }}>
          {() => <SharesScreen baseUrl={data.apiBaseUrl} onUnauthorized={data.onUnauthorized} />}
        </Stack.Screen>
        <Stack.Screen name="Family" options={{ title: dict.family.title }}>
          {() => <FamilyScreen baseUrl={data.apiBaseUrl} onUnauthorized={data.onUnauthorized} />}
        </Stack.Screen>
        <Stack.Screen name="Folder" options={({ route }) => ({ title: findLive(route.params.id)?.title ?? t('mobileUI.files') })}>
          {({ navigation, route }) => <FilesScreen folderId={route.params.id} items={data.items} onSave={data.onSave} onDelete={data.onDelete}
            onOpenFolder={id => navigation.push('Folder', { id })} onOpenFile={id => navigation.navigate('File', { id })} />}
        </Stack.Screen>
        <Stack.Screen name="ImportFiles" options={{ title: t('mobileUI.files'), headerRight: () => null }}>
          {({ navigation, route }) => <FilesScreen initialPicker={route.params.picker} items={data.items} onSave={data.onSave} onDelete={data.onDelete}
            onOpenFolder={id => navigation.push('Folder', { id })} onOpenFile={id => navigation.navigate('File', { id })} />}
        </Stack.Screen>
        <Stack.Screen name="Collection" options={({ route, navigation }) => ({
          title: findLive(route.params.id)?.title ?? dict.itemTypes.collection, presentation: 'modal', headerBackVisible: false,
          headerRight: () => <ScreenHeaderAction icon="close" label={dict.common.close} testID="collection-close" onPress={() => navigation.goBack()} />,
        })}>
          {({ navigation, route }) => {
            const linked = new Set(findLive(route.params.id)?.relations.filter(relation => relation.type === 'contains').map(relation => relation.target_id));
            const members = data.items.filter(item => item.fields.parent_id === route.params.id || linked.has(item.id));
            return <AppPage width="list" scroll={false} safeArea="bottom">
              <FlatList data={members} keyExtractor={item => item.id}
                ListEmptyComponent={<EmptyState image={illustrations.emptyVault} title={t('mobileUI.noItems')} />}
                renderItem={({ item }) => <ItemRow item={item} onPress={() => openItem(navigation, item, item.id, true)} />} />
            </AppPage>;
          }}
        </Stack.Screen>
        <Stack.Screen name="File" options={({ navigation }) => ({
          title: t('mobileUI.files'), presentation: 'modal', headerBackVisible: false,
          headerRight: () => <ScreenHeaderAction icon="close" label={dict.common.close} testID="file-close" onPress={() => navigation.goBack()} />,
        })}>
          {({ route }) => {
            const item = findLive(route.params.id);
            return item ? <FilePreviewScreen item={item} /> : <AppPage><EmptyState title={t('mobileUI.fileUnavailable')} /></AppPage>;
          }}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}
