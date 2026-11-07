import { Bluetooth, RefreshCw, Volume2 } from 'lucide-react';
import type { ClientAudioDevice } from '@meeting/contracts';
import { useI18n } from '../i18n/i18n.js';
import type { AndroidAudioControls } from './android-audio-routes.js';

export function AndroidAudioSettings({ audio }: { audio: AndroidAudioControls }) {
  const { t } = useI18n();
  if (audio.availability !== 'supported') return <p className="meeting-settings-field-wide meeting-settings-share-hint" role="status">
    {t(audio.availability === 'upgrade' ? 'audio.nativeUpgrade' : 'audio.nativeUnavailable')}
  </p>;
  const state = audio.state;
  const busy = Boolean(audio.operation || state?.pendingId);
  const name = (device: ClientAudioDevice) => device.type === 'default' ? t('audio.systemDefault')
    : device.type === 'speaker' || device.type === 'earpiece' ? t(`audio.device.${device.type}`) : device.label || t(`audio.device.${device.type}`);
  const actual = state?.devices.find(device => device.id === state.actualDeviceId);
  const selectedMissing = state && !state.devices.some(device => device.id === state.selectedId);
  const bluetoothRequired = state?.bluetoothPermission === 'required' || state?.bluetoothPermission === 'denied';
  return <div className="meeting-settings-field-wide">
    <label className="meeting-device-control"><span><Volume2 aria-hidden="true" size={17} />{t('audio.communicationDevice')}</span>
      <select aria-label={t('audio.communicationDevice')} value={state?.selectedId ?? ''} disabled={!audio.active || !state?.canSelect || busy}
        onChange={event => { void audio.select(event.target.value); }}>
        {!state && <option value="">{t(audio.active ? 'audio.loading' : 'audio.connectFirst')}</option>}
        {selectedMissing && <option value={state.selectedId} disabled>{t('audio.disconnectedDevice')}</option>}
        {state?.devices.map(device => <option key={device.id} value={device.id}>{name(device)}</option>)}
      </select>
    </label>
    <p className="meeting-settings-share-hint">{t('audio.microphoneFollows')}</p>
    {state && <p className="meeting-settings-share-hint" role="status">{t('audio.actualDevice', { name: actual ? name(actual) : t('audio.systemDetermines') })}</p>}
    {busy && <p className="meeting-settings-share-hint" role="status">{t(audio.operation === 'permission' ? 'audio.permissionPending' : audio.operation === 'loading' ? 'audio.loading' : 'audio.switching')}</p>}
    {audio.error && <p className="message error" role="alert">{t(`audio.error.${audio.error}`)}</p>}
    {state?.bluetoothPermission === 'denied' && <p className="meeting-settings-share-hint">{t('audio.bluetoothDenied')}</p>}
    <div className="meeting-settings-native-audio-actions">
      <button className="secondary" type="button" disabled={!audio.active || Boolean(audio.operation)} onClick={() => { void audio.refresh(); }}><RefreshCw aria-hidden="true" size={15} />{t('audio.refresh')}</button>
      {bluetoothRequired && <button className="secondary" type="button" disabled={!audio.active || busy} onClick={() => { void audio.requestBluetoothPermission(); }}><Bluetooth aria-hidden="true" size={15} />{t('audio.allowBluetooth')}</button>}
    </div>
    {bluetoothRequired && <p className="meeting-settings-share-hint">{t('audio.bluetoothHint')}</p>}
  </div>;
}
