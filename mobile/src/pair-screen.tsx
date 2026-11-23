// Adapted from DS Bot 0.3.8 (Apache-2.0), mobile/src/screens/Pair.tsx (see NOTICE).
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ArrowLeft, ScanLine } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { parsePairingUri } from '@phone-link';
import { connectToComputer, linkError, type PhoneIdentity, type SavedComputer } from './connection';
import { Button, radius, type, usePalette } from './theme';

export function PairScreen({ identity, onPaired, onCancel, foreground, phoneName }: {
  identity: PhoneIdentity; onPaired: (computer: SavedComputer) => Promise<void>; onCancel: () => void;
  foreground: boolean; phoneName: string;
}) {
  const palette = usePalette();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);

  async function pair(uri: string) {
    if (pending.current) return;
    setScanning(false);
    let offer;
    try { offer = parsePairingUri(uri.trim()); }
    catch { setError('This is not a valid DS SuperAgent pairing link. Open a new code on the computer.'); return; }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setLink('');
    const { code, ...computer } = offer;
    const connection = connectToComputer(computer, identity, phoneName, code);
    try {
      await connection.open(controller.signal);
      if (!controller.signal.aborted) {
        await connection.close();
        await onPaired(computer);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(linkError(failure, 'Pairing could not finish. Check the relay and show a fresh QR code on the computer.'));
    } finally {
      await connection.close();
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function scan() {
    try {
      if (permission?.canAskAgain === false && !permission.granted) {
        await Linking.openSettings();
        return;
      }
      const granted = permission?.granted || (await requestPermission()).granted;
      setScanning(granted);
      setError(granted ? '' : 'Camera access is off. You can still paste a pairing link.');
    } catch { setError('The camera is unavailable. You can still paste a pairing link.'); }
  }

  return <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.body}>
    <View style={styles.heading}>
      <Button compact label="Back" icon={color => <ArrowLeft size={19} color={color} />} disabled={busy} onPress={onCancel} />
      <Text accessibilityRole="header" style={[type.title, { color: palette.ink, flexShrink: 1 }]}>Pair a computer</Text>
    </View>
    <Text style={[type.caption, { color: palette.muted }]}>DS SuperAgent / Settings / Phone</Text>
    {scanning && foreground ? <View style={[styles.camera, { backgroundColor: palette.surface }]}>
      <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => { if (data.startsWith('ds-superagent://')) void pair(data); }}
        onMountError={() => { setScanning(false); setError('The camera is unavailable. You can still paste a pairing link.'); }} />
      <View style={styles.cameraClose}><Button label="Stop scanning" onPress={() => setScanning(false)} /></View>
    </View> : <Button label={permission?.canAskAgain === false && !permission.granted ? 'Open camera settings' : 'Scan QR code'}
      icon={color => <ScanLine size={20} color={color} />} onPress={() => void scan()} disabled={busy} />}
    <TextInput accessibilityLabel="Pairing link" placeholder="Pairing link" placeholderTextColor={palette.muted} secureTextEntry
      autoCapitalize="none" autoCorrect={false} autoComplete="off" spellCheck={false} returnKeyType="go" editable={!busy}
      style={[styles.input, type.body, { color: palette.ink, backgroundColor: palette.surface, borderColor: palette.separator }]}
      value={link} maxLength={2048} onChangeText={setLink} onSubmitEditing={() => { if (link.trim()) void pair(link); }} />
    <Button label="Pair" primary disabled={busy || !link.trim()} onPress={() => void pair(link)} />
    {busy && <ActivityIndicator accessibilityLabel="Pairing" color={palette.accent} />}
    {error !== '' && <Text accessibilityRole="alert" style={[type.body, { color: palette.danger }]}>{error}</Text>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  body: { padding: 18, gap: 14, width: '100%', maxWidth: 560, alignSelf: 'center' },
  heading: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  camera: { width: '100%', maxHeight: 330, aspectRatio: 1, borderRadius: radius.input, overflow: 'hidden' },
  cameraClose: { position: 'absolute', bottom: 8, right: 8 },
  input: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.input, paddingHorizontal: 12, paddingVertical: 8 },
});
