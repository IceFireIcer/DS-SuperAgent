import { StatusBar } from 'expo-status-bar';
import { ArrowLeft, Monitor, Plus, RefreshCw, Send, Trash2 } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, FlatList, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { linkError, type MainMessage, type PhoneIdentity, type SavedComputer } from './src/connection';
import { PairScreen } from './src/pair-screen';
import { clearSend, loadComputers, loadIdentity, reserveSend, saveComputers } from './src/store';
import { Button, radius, type, usePalette } from './src/theme';
import { useComputer } from './src/use-computer';

const workState: Record<string, string> = { running: 'In progress', 'waiting-human': 'Needs attention',
  'waiting-delivery': 'Waiting for delivery', delivered: 'Delivered', stopped: 'Stopped' };
const mainState: Record<string, string> = { ready: 'Ready', running: 'Replying', degraded: 'Main needs attention' };
const phoneName = Platform.OS === 'ios' ? (Platform.isPad ? 'iPad' : 'iPhone') : 'Android phone';

function MainMessageRow({ message }: { message: MainMessage }) {
  const palette = usePalette();
  const user = message.role === 'user';
  return <View style={[styles.message, { alignSelf: user ? 'flex-end' : 'flex-start', backgroundColor: user ? palette.outgoing : palette.surface }]}>
    <Text style={[type.caption, { color: palette.muted }]}>{user ? 'You' : message.role === 'system' ? 'System' : 'Main'}</Text>
    {message.text ? <Text selectable style={[type.body, { color: palette.ink }]}>{message.text}</Text> : null}
    {message.status !== 'completed' && <Text style={[type.caption, { color: message.status === 'failed' ? palette.danger : palette.muted }]}>
      {({ queued: 'Queued', running: 'Reply pending', failed: 'Reply failed', interrupted: 'Interrupted', stopped: 'Stopped' } as Record<string, string>)[message.status] ?? 'Pending'}
    </Text>}
  </View>;
}

function Computer({ computer, identity, active, onBack }: {
  computer: SavedComputer; identity: PhoneIdentity; active: boolean; onBack: () => void;
}) {
  const palette = usePalette();
  const access = useComputer(computer, identity, phoneName, active);
  const [tab, setTab] = useState<'Main' | 'Work'>('Main');
  const [draft, setDraft] = useState('');
  const [awaiting, setAwaiting] = useState(false);
  const [sendError, setSendError] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const sending = useRef(false);
  const online = access.state === 'online';

  async function submit() {
    const text = draft.trim();
    if (!active || !online || !access.canSend || !text || sending.current || access.readingEarlier) return;
    sending.current = true;
    setAwaiting(true);
    setSendError('');
    try {
      const commandId = await reserveSend(computer.hostDeviceId, text);
      setUnconfirmed(true);
      const receipt = await access.send(text, commandId);
      if (!receipt?.messageId) throw new Error('The computer returned no message receipt.');
      await clearSend(computer.hostDeviceId, commandId);
      setUnconfirmed(false);
      setDraft('');
      if (receipt.status !== 'completed') setSendError('The computer saved the message, but the reply did not finish.');
    } catch (failure) {
      if ((failure as { code?: string })?.code === 'MOBILE_SEND_PENDING') setUnconfirmed(true);
      setSendError(linkError(failure, 'Delivery was not confirmed. Retry uses the same message.'));
    } finally { sending.current = false; setAwaiting(false); }
  }

  function discardSend() {
    Alert.alert('Discard the retry record?', 'Check Main first. The computer may already have saved your message.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => {
        void clearSend(computer.hostDeviceId).then(() => { setUnconfirmed(false); setSendError(''); })
          .catch(() => setSendError('The retry record could not be removed.'));
      } },
    ]);
  }

  const connectionText = access.state === 'connecting' ? 'Connecting' : !online ? 'Disconnected' : access.canSend ? 'Connected' : 'Connected · Read only';
  const messages = access.history?.messages ?? [];
  const refresh = () => { if (online) void access.refresh(); else access.reconnect(); };
  return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={[styles.toolbar, { borderColor: palette.separator }]}>
      <Button compact label="Computers" icon={color => <ArrowLeft size={19} color={color} />} disabled={awaiting} onPress={onBack} />
      <View style={styles.heading}>
        <Text accessibilityRole="header" numberOfLines={1} style={[type.header, { color: palette.ink }]}>{computer.name || 'Computer'}</Text>
        <Text accessibilityLiveRegion="polite" style={[type.caption, { color: palette.muted }]}>{connectionText}</Text>
      </View>
      <Button compact label={online ? 'Refresh' : 'Reconnect'} icon={color => <RefreshCw size={19} color={color} />}
        disabled={!active || access.state === 'connecting'} onPress={refresh} />
    </View>
    <View style={[styles.tabs, { borderColor: palette.separator }]}>
      {(['Main', 'Work'] as const).map(name => <Pressable key={name} onPress={() => setTab(name)} accessibilityRole="tab"
        accessibilityState={{ selected: tab === name }} style={[styles.tab, { borderBottomColor: tab === name ? palette.accent : 'transparent' }]}>
        <Text style={[type.body, { color: tab === name ? palette.accent : palette.muted }]}>{name}</Text>
      </Pressable>)}
    </View>
    {access.error !== '' && <Text accessibilityRole="alert" style={[styles.banner, type.caption, { color: palette.danger }]}>{access.error}</Text>}
    {tab === 'Main' ? <>
      {access.readingEarlier && <Button label="Latest messages" onPress={access.showLatest} />}
      <FlatList data={[...messages].reverse()} inverted={messages.length > 0} keyboardShouldPersistTaps="handled"
        keyExtractor={item => item.id} renderItem={({ item }) => <MainMessageRow message={item} />}
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 36 }}
        contentContainerStyle={styles.messages} ListFooterComponent={access.before ?
          <Button label={access.olderLoading ? 'Loading earlier messages' : 'Earlier messages'} disabled={!online || access.olderLoading}
            onPress={() => void access.loadOlder()} /> : undefined}
        ListEmptyComponent={<Text style={[styles.empty, type.body, { color: palette.muted }]}>
          {online && access.history ? 'No messages yet' : access.state === 'offline' ? 'Computer offline' : 'Loading Main'}
        </Text>} />
      {sendError !== '' && <Text accessibilityRole="alert" style={[styles.banner, type.caption, { color: palette.danger }]}>{sendError}</Text>}
      {unconfirmed && !awaiting && <Button label="Discard retry record" onPress={discardSend} />}
      {online && access.canSend && !access.readingEarlier && <View style={[styles.composer, { borderColor: palette.separator }]}>
        <TextInput accessibilityLabel="Message Main" multiline value={draft} editable={!awaiting} maxLength={8000}
          onChangeText={setDraft} style={[styles.draft, type.body, { color: palette.ink, backgroundColor: palette.surface }]}
          placeholder="Message Main" placeholderTextColor={palette.muted} />
        <Button compact primary label={awaiting ? 'Sending' : unconfirmed ? 'Retry message' : 'Send'}
          disabled={!draft.trim() || awaiting || !active} icon={color => awaiting ? <ActivityIndicator color={color} /> : <Send size={18} color={color} />}
          onPress={() => void submit()} />
      </View>}
    </> : <ScrollView contentContainerStyle={styles.work}>
      <Text accessibilityRole="header" style={[type.header, { color: palette.ink }]}>Work status</Text>
      <Text style={[type.caption, { color: palette.muted }]}>{online ? `Main: ${mainState[access.history?.mainState ?? ''] ?? 'Status unavailable'}` : 'Computer offline'}</Text>
      {access.browsingWork && <Button label="First work page" onPress={access.showFirstWork} />}
      {access.work?.items.map(item => <View key={item.id} style={[styles.workItem, { borderColor: palette.separator }]}>
        <Text style={[type.caption, { color: palette.accent }]}>{workState[item.state] ?? 'Status unavailable'}</Text>
        <Text style={[type.body, { color: palette.ink }]}>{item.goal}</Text>
        {item.summary ? <Text style={[type.caption, { color: palette.muted }]}>{item.summary}</Text> : null}
      </View>)}
      {online && access.work?.items.length === 0 && <Text style={[type.body, { color: palette.muted }]}>No work on this page</Text>}
      {access.work?.after && <Button label="More work" disabled={!online || access.workLoading} onPress={() => void access.loadMoreWork()} />}
    </ScrollView>}
  </KeyboardAvoidingView>;
}

function Application() {
  const palette = usePalette();
  const [identity, setIdentity] = useState<PhoneIdentity>();
  const [computers, setComputers] = useState<SavedComputer[]>([]);
  const [screen, setScreen] = useState<'computers' | 'pair' | 'computer'>('computers');
  const [selected, setSelected] = useState<SavedComputer>();
  const [foreground, setForeground] = useState(AppState.currentState === null || AppState.currentState === 'active');
  const [error, setError] = useState('');
  const updating = useRef(false);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'));
    let live = true;
    void Promise.all([loadIdentity(), loadComputers()]).then(([phone, list]) => {
      if (!live) return;
      setIdentity(phone);
      setComputers(list);
      if (list.length === 1) { setSelected(list[0]); setScreen('computer'); }
    }).catch(() => { if (live) setError('Secure storage could not be opened. Unlock this phone and reopen the app.'); });
    return () => { live = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'computers') return false;
      setScreen('computers');
      return true;
    });
    return () => subscription.remove();
  }, [screen]);

  async function onPaired(computer: SavedComputer) {
    const list = [...computers.filter(item => item.hostDeviceId !== computer.hostDeviceId), computer];
    await saveComputers(list);
    setComputers(list);
    setSelected(computer);
    setScreen('computer');
  }

  function forget(computer: SavedComputer) {
    Alert.alert('Forget this computer?', 'This removes the pairing from this phone. To revoke access, remove this phone in the computer settings.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Forget', style: 'destructive', onPress: () => {
        if (updating.current) return;
        updating.current = true;
        const list = computers.filter(item => item.hostDeviceId !== computer.hostDeviceId);
        void saveComputers(list).then(() => { setComputers(list); setError(''); })
          .catch(() => setError('The computer could not be removed from secure storage.')).finally(() => { updating.current = false; });
      } },
    ]);
  }

  return <SafeAreaView style={[styles.screen, { backgroundColor: palette.bg }]}>
    <StatusBar style="auto" />
    {identity && screen === 'computer' && selected ? <Computer key={selected.hostDeviceId} computer={selected} identity={identity}
      active={foreground} onBack={() => setScreen('computers')} /> : identity && screen === 'pair' ?
        <PairScreen identity={identity} phoneName={phoneName} onPaired={onPaired} onCancel={() => setScreen('computers')} foreground={foreground} /> :
        <ScrollView contentContainerStyle={styles.work}>
          <Text accessibilityRole="header" style={[type.title, { color: palette.ink }]}>DS SuperAgent</Text>
          <View style={styles.directoryHeader}>
            <Text style={[type.header, { color: palette.ink }]}>Computers</Text>
            <Button label="Pair computer" primary icon={color => <Plus size={18} color={color} />}
              onPress={() => setScreen('pair')} disabled={!identity} />
          </View>
          {error ? <Text accessibilityRole="alert" style={[type.body, { color: palette.danger }]}>{error}</Text> : null}
          {!identity && !error && <ActivityIndicator accessibilityLabel="Loading computers" color={palette.accent} />}
          {identity && !computers.length && <Text style={[type.body, { color: palette.muted }]}>No paired computers</Text>}
          {computers.map(computer => <View key={computer.hostDeviceId} style={[styles.computerRow, { borderColor: palette.separator }]}>
            <Pressable accessibilityRole="button" onPress={() => { setSelected(computer); setScreen('computer'); }} style={styles.computerName}>
              <Monitor size={21} color={palette.accent} />
              <Text style={[type.body, { flexShrink: 1, color: palette.ink }]}>{computer.name || 'Computer'}</Text>
            </Pressable>
            <Button compact label={`Forget ${computer.name || 'computer'}`} icon={color => <Trash2 size={17} color={color} />} onPress={() => forget(computer)} />
          </View>)}
        </ScrollView>}
  </SafeAreaView>;
}

export default function App() {
  return <SafeAreaProvider><Application /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  heading: { flex: 1, minWidth: 0 },
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12 },
  tab: { flex: 1, minHeight: 44, borderBottomWidth: 2, alignItems: 'center', justifyContent: 'center' },
  banner: { paddingHorizontal: 16, paddingVertical: 8 },
  messages: { padding: 16, gap: 10 },
  message: { maxWidth: '92%', gap: 4, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.bubble },
  empty: { textAlign: 'center', padding: 18 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', borderTopWidth: StyleSheet.hairlineWidth, padding: 10, gap: 8 },
  draft: { flex: 1, minHeight: 44, maxHeight: 140, borderRadius: radius.bubble, paddingVertical: 10, paddingHorizontal: 13 },
  work: { padding: 18, gap: 12, maxWidth: 720, width: '100%', alignSelf: 'center' },
  workItem: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
  directoryHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  computerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  computerName: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52 },
});
