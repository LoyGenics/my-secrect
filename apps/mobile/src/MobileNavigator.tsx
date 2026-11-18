import React, { useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { NavigationContainer, DarkTheme, DefaultTheme, StackActions, usePreventRemove, type NavigationAction } from '@react-navigation/native';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Plus, Search, X } from 'lucide-react-native';
import { Icon, type IconName } from '../../../packages/ui/src/native';
import type { VaultItem } from '../../../packages/core/src/types';
import { useTranslation } from '../../../packages/i18n/src/react';
import { useMobileTheme } from './theme';
import { IconButton } from './components/mobile-ui';
import VaultScreen from './screens/VaultScreen';
import SearchScreen from './screens/SearchScreen';
import GeneratorScreen from './screens/GeneratorScreen';
import HealthScreen from './screens/HealthScreen';
import SettingsScreen, { type AutoLockMinutes } from './screens/SettingsScreen';
import SecurityScreen from './screens/SecurityScreen';
import ItemDetailScreen from './screens/ItemDetailScreen';
import ItemFormScreen from './screens/ItemFormScreen';
import TrashScreen from './screens/TrashScreen';
import FamilyScreen from './screens/FamilyScreen';
import SharesScreen from './screens/SharesScreen';
import FilesScreen, { FilePreviewScreen } from './screens/FilesScreen';
import { isFile, isFileFolder } from '../../../packages/core/src/files';
import ShareLinkScreen from './screens/ShareLinkScreen';

type Routes = {
  Home: undefined; Search: undefined; Detail: { id: string }; Form: { id?: string } | undefined;
  Folder: { id: string }; File: { id: string }; ShareLink: { id: string }; Trash: undefined; Security: undefined; Family: undefined; Shares: undefined;
};
const Stack = createNativeStackNavigator<Routes>();
const Tabs = createBottomTabNavigator();
export interface MobileNavigationProps {
  items: VaultItem[]; trash: VaultItem[]; autoLock: AutoLockMinutes; notice: string;
  onSave: (item: VaultItem, localCardCode?: string) => Promise<void>; onDelete: (id: string) => Promise<void>;
  onRestore: (id: string) => Promise<void>; onToggleFavorite: (id: string) => void;
  onLoadExamples: (items: VaultItem[]) => void; onClearExamples: (ids: string[]) => void;
  onAutoLockChange: (minutes: AutoLockMinutes) => void; onLock: () => void;
  onWiped: () => void; setNotice: (notice: string) => void;
  apiBaseUrl: string; signedIn: boolean; onSignIn: () => void;
  onSignedOut: () => void; onUnauthorized: () => void;
  onServerSaved: (url: string) => Promise<void>;
}

function HeaderAction({ label, testID, onPress, children }: { label: string; testID: string; onPress: () => void; children: React.ReactNode }) {
  return <IconButton accessibilityLabel={label} testID={testID} onPress={onPress}>{children}</IconButton>;
}

function FormRoute({ navigation, route, data }: NativeStackScreenProps<Routes, 'Form'> & { data: MobileNavigationProps }) {
  const { t } = useTranslation();
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<NavigationAction | null>(null);
  const initial = data.items.find(i => i.id === route.params?.id);
  usePreventRemove(dirty, ({ data: event }) => Alert.alert(t('mobileUI.discardTitle'), t('mobileUI.discardBody'), [
    { text: t('mobileUI.keepEditing'), style: 'cancel' },
    { text: t('mobileUI.discard'), style: 'destructive', onPress: () => { setDirty(false); setPending(event.action); } },
  ]));
  useEffect(() => { if (pending && !dirty) { navigation.dispatch(pending); setPending(null); } }, [pending, dirty, navigation]);
  return <ItemFormScreen initial={initial} allItems={data.items} onDirtyChange={setDirty} onSave={async (item, localCardCode) => {
    await data.onSave(item, localCardCode);
    setDirty(false);
    setPending(initial ? StackActions.pop() : StackActions.replace('Detail', { id: item.id }));
  }} />;
}

function MainTabs({ data, navigation }: { data: MobileNavigationProps; navigation: NativeStackScreenProps<Routes, 'Home'>['navigation'] }) {
  const { dict, t } = useTranslation(); const { colors } = useMobileTheme();
  const entries: Array<{ key: string; title: string; icon: IconName }> = [
    { key: 'vault', title: dict.shell.tabs.vault, icon: 'items' },
    { key: 'files', title: t('mobileUI.files'), icon: 'documents' },
    { key: 'generator', title: dict.shell.tabs.generator, icon: 'generate' },
    { key: 'health', title: dict.shell.tabs.watchtower, icon: 'health' },
    { key: 'settings', title: dict.shell.tabs.settings, icon: 'settings' },
  ];
  const [active, setActive] = useState('vault');
  useEffect(() => navigation.setOptions({ title: entries.find(entry => entry.key === active)?.title, headerRight: () => <View style={{ flexDirection: 'row' }}>{active !== 'vault' && <HeaderAction label={t('mobileUI.searchAll')} testID="header-global-search" onPress={() => navigation.navigate('Search')}><Search size={21} color={colors.link} /></HeaderAction>}{active !== 'files' && <HeaderAction label={dict.shell.newItem} testID="new-item-button" onPress={() => navigation.navigate('Form')}><Plus size={25} color={colors.link} /></HeaderAction>}</View> }), [active, dict, navigation, colors.link]);
  const select = (id: string) => { const item = data.items.find(item => item.id === id); navigation.navigate(item && isFile(item) ? 'File' : item && isFileFolder(item) ? 'Folder' : 'Detail', { id }); };
  const openAccount = (screen: 'Security' | 'Shares' | 'Family') => {
    if (data.apiBaseUrl && !data.signedIn) data.onSignIn();
    else navigation.navigate(screen);
  };
  return <View style={{ flex: 1 }}>
    <Tabs.Navigator screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.link, tabBarInactiveTintColor: colors.muted, tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.line }, tabBarLabelStyle: { fontSize: 11, fontWeight: '500' }, sceneStyle: { backgroundColor: colors.bg } }}>
      {entries.map(entry => <Tabs.Screen key={entry.key} name={entry.key} options={{ title: entry.title, tabBarButtonTestID: `tab-${entry.key}`, tabBarIcon: ({ color }) => <Icon name={entry.icon} color={color} size="lg" /> }} listeners={{ focus: () => setActive(entry.key) }}>
        {() => entry.key === 'vault' ? <VaultScreen {...data} onSelect={select} onNew={() => navigation.navigate('Form')} onSearch={() => navigation.navigate('Search')} onOpen={openAccount} />
          : entry.key === 'files' ? <FilesScreen items={data.items} onSave={data.onSave} onDelete={data.onDelete} onOpenFolder={id => navigation.navigate('Folder', { id })} onOpenFile={id => navigation.navigate('File', { id })} />
          : entry.key === 'generator' ? <GeneratorScreen />
          : entry.key === 'health' ? <HealthScreen items={data.items} onFix={item => navigation.navigate('Form', { id: item.id })} />
          : <SettingsScreen {...data} onViewTrash={() => navigation.navigate('Trash')} onViewSecurity={() => openAccount('Security')} onOpen={openAccount} onSearch={() => navigation.navigate('Search')} />}
      </Tabs.Screen>)}
    </Tabs.Navigator>
    {!!data.notice && <Pressable testID="app-notice" accessibilityLabel={dict.mobile.dismissNotice} onPress={() => data.setNotice('')} style={{ position: 'absolute', bottom: 100, left: 20, right: 20, backgroundColor: colors.card, padding: 14, borderRadius: 12, shadowColor: '#000000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.12, shadowRadius: 12 }}><Text style={{ color: colors.secondary, fontSize: 13, textAlign: 'center' }}>{data.notice}</Text></Pressable>}
  </View>;
}

export default function MobileNavigator(data: MobileNavigationProps) {
  const { colors, scheme } = useMobileTheme(); const { dict, t } = useTranslation();
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  return <SafeAreaProvider><NavigationContainer theme={{ ...base, colors: { ...base.colors, primary: colors.link, background: colors.bg, card: colors.bg, text: colors.text, border: colors.line } }}>
    <Stack.Navigator screenOptions={({ navigation }) => ({ headerShadowVisible: false, headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.link, headerTitleStyle: { color: colors.text, fontWeight: '600' }, contentStyle: { backgroundColor: colors.bg }, headerBackButtonDisplayMode: 'minimal', headerTitle: ({ children }) => <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>{children}</Text>, headerRight: () => <HeaderAction label={t('mobileUI.searchAll')} testID="header-global-search" onPress={() => navigation.navigate('Search')}><Search size={21} color={colors.link} /></HeaderAction> })}>
      <Stack.Screen name="Home" options={({ navigation }) => ({ title: dict.shell.tabs.vault, headerLargeTitle: false, headerRight: () => <View style={{ flexDirection: 'row' }}><HeaderAction label={t('mobileUI.searchAll')} testID="header-global-search" onPress={() => navigation.navigate('Search')}><Search size={21} color={colors.link} /></HeaderAction><HeaderAction label={dict.shell.newItem} testID="new-item-button" onPress={() => navigation.navigate('Form')}><Plus size={25} color={colors.link} /></HeaderAction></View> })}>
        {props => <MainTabs {...props} data={data} />}
      </Stack.Screen>
      <Stack.Screen name="Search" options={({ navigation }) => ({ title: dict.search.title, presentation: 'modal', headerRight: () => <HeaderAction label={dict.common.close} testID="search-close" onPress={() => navigation.goBack()}><X size={21} color={colors.link} /></HeaderAction> })}>
        {({ navigation }) => <SearchScreen items={data.items} onToggleFavorite={data.onToggleFavorite} onSelect={id => { const item = data.items.find(item => item.id === id); navigation.push(item && isFile(item) ? 'File' : item && isFileFolder(item) ? 'Folder' : 'Detail', { id }); }} />}
      </Stack.Screen>
      <Stack.Screen name="Form" options={({ route }) => ({ title: route.params?.id ? dict.itemForm.editTitle : dict.itemForm.newTitle, headerRight: () => null })}>{props => <FormRoute {...props} data={data} />}</Stack.Screen>
      <Stack.Screen name="Detail" options={{ title: '' }}>{({ navigation, route }) => {
        const item = [...data.items, ...data.trash].find(i => i.id === route.params.id);
        return item ? <ItemDetailScreen item={item} allItems={data.items} inTrash={data.trash.some(i => i.id === item.id)} onShare={() => {
          if (data.apiBaseUrl && !data.signedIn) data.onSignIn();
          else navigation.navigate('ShareLink', { id: item.id });
        }} onClose={() => navigation.goBack()} onSelectRelated={id => navigation.push('Detail', { id })} onEdit={() => navigation.navigate('Form', { id: item.id })} onDelete={async () => { await data.onDelete(item.id); navigation.goBack(); }} onRestore={async () => { await data.onRestore(item.id); }} onToggleFavorite={() => data.onToggleFavorite(item.id)} /> : null;
      }}</Stack.Screen>
      <Stack.Screen name="ShareLink" options={{ title: t('mobileUI.shareLink') }}>{({ route }) => {
        const item = data.items.find(value => value.id === route.params.id);
        return item ? <ShareLinkScreen item={item} baseUrl={data.apiBaseUrl} /> : null;
      }}</Stack.Screen>
      <Stack.Screen name="Trash" options={{ title: dict.shell.trash }}>{({ navigation }) => <TrashScreen trash={data.trash} onSelect={id => navigation.navigate('Detail', { id })} onRestore={id => void data.onRestore(id)} onPermanentDelete={id => void data.onDelete(id)} />}</Stack.Screen>
      <Stack.Screen name="Security" options={{ title: dict.security.title }}>{({ navigation }) => <SecurityScreen baseUrl={data.apiBaseUrl} onClose={() => navigation.goBack()} onSignedOut={data.onSignedOut} onUnauthorized={data.onUnauthorized} />}</Stack.Screen>
      <Stack.Screen name="Shares" options={{ title: dict.shares.title }}>{({ navigation }) => <SharesScreen baseUrl={data.apiBaseUrl} onClose={() => navigation.goBack()} />}</Stack.Screen>
      <Stack.Screen name="Family" options={{ title: dict.family.title }}>{({ navigation }) => <FamilyScreen baseUrl={data.apiBaseUrl} onClose={() => navigation.goBack()} />}</Stack.Screen>
      <Stack.Screen name="Folder" options={({ route }) => ({ title: data.items.find(item => item.id === route.params.id)?.title || t('mobileUI.files') })}>{({ navigation, route }) => <FilesScreen folderId={route.params.id} items={data.items} onSave={data.onSave} onDelete={data.onDelete} onOpenFolder={id => navigation.push('Folder', { id })} onOpenFile={id => navigation.navigate('File', { id })} />}</Stack.Screen>
      <Stack.Screen name="File" options={{ title: t('mobileUI.files') }}>{({ route }) => {
        const item = data.items.find(item => item.id === route.params.id);
        return item ? <FilePreviewScreen item={item} /> : null;
      }}</Stack.Screen>
    </Stack.Navigator>
  </NavigationContainer></SafeAreaProvider>;
}
