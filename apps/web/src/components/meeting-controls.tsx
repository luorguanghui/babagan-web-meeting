import type { P2pTurnProvider, ScreenShareCodec, ScreenShareQuality } from '@meeting/contracts';
import { Activity, ChevronDown, ChevronUp, Ellipsis, LogOut, Mic, MicOff, MonitorUp, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';

import { useI18n } from '../i18n/i18n.js';
import { useExitPresence } from './use-exit-presence.js';
import type { MeetingConnectionState } from '../meeting/room-controller.js';
import type { ScreenShareTurnProviderPreference } from '../meeting/screen-turn-provider-preference.js';
import type { ViewerTransportPreference } from '../meeting/viewer-transport-preference.js';
import {
  recommendP2pBitrate,
  screenShareBitrates,
  screenShareDefaultBitrate,
  screenShareDefaultQuality,
  type ScreenShareBitrate
} from '../meeting/screen-share.js';

import './meeting-quick-controls.css';

export type MeetingQuickPanel = 'audio' | 'share' | null;

export interface MeetingControlsProps {
  className?: string;
  connection: MeetingConnectionState;
  microphoneEnabled: boolean;
  audioPlaybackBlocked: boolean;
  callAudioVolume?: number;
  sharedAudioVolume?: number;
  sharedAudioVolumeVisible?: boolean;
  devices: MediaDeviceInfo[];
  microphoneDeviceId?: string;
  speakerDeviceId?: string;
  quickPanel?: MeetingQuickPanel;
  audioSettingsButtonRef?: RefObject<HTMLButtonElement | null>;
  shareSettingsButtonRef?: RefObject<HTMLButtonElement | null>;
  onQuickPanelChange?: (panel: MeetingQuickPanel) => void;
  leaving: boolean;
  screenShareAuthorized?: boolean;
  screenShareActive?: boolean;
  screenShareBusy?: boolean;
  screenShareStopping?: boolean;
  screenCodec?: ScreenShareCodec;
  screenEncodingEngine?: 'project' | 'browser';
  screenSourceTransport?: 'p2p' | 'cloudflare-sfu';
  onScreenSourceTransportChange?: (transport: 'p2p' | 'cloudflare-sfu') => void;
  cloudflareSfuAvailable?: boolean;
  onScreenEncodingEngineChange?: (value: 'project' | 'browser') => void;
  screenBitrate?: ScreenShareBitrate;
  screenQuality?: ScreenShareQuality;
  screenViewerCount?: number;
  p2pRetryVisible?: boolean;
  screenShareTurnProvider?: ScreenShareTurnProviderPreference;
  availableTurnProviders?: readonly P2pTurnProvider[];
  screenShareTurnProviderVisible?: boolean;
  viewerTransportPreferenceVisible?: boolean;
  viewerTransportPreference?: ViewerTransportPreference;
  onScreenShareTurnProviderChange?: (preference: ScreenShareTurnProviderPreference) => void;
  onViewerTransportPreferenceChange?: (preference: ViewerTransportPreference) => void;
  onMicrophoneToggle: () => void;
  onMicrophoneDeviceChange: (deviceId: string) => void;
  onSpeakerDeviceChange: (deviceId: string) => void;
  onResumeAudio: () => void;
  onCallAudioVolumeChange?: (volume: number) => void;
  onSharedAudioVolumeChange?: (volume: number) => void;
  onScreenCodecChange?: (codec: ScreenShareCodec) => void;
  onScreenBitrateChange?: (bitrate: ScreenShareBitrate) => void;
  onScreenQualityChange?: (quality: ScreenShareQuality) => void;
  onScreenShareToggle?: () => void;
  onP2pRetry?: () => void;
  onMore?: () => void;
  moreButtonRef?: RefObject<HTMLButtonElement | null>;
  includeSettings?: boolean;
  onOpenDiagnostics?: () => void;
  onLeave: () => void;
}

export function MeetingControls(props: MeetingControlsProps) {
  const { t } = useI18n();
  const [internalQuickPanel, setInternalQuickPanel] = useState<MeetingQuickPanel>(null);
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState('');
  const [speakerDeviceId, setSpeakerDeviceId] = useState('');
  const quickPanel = props.quickPanel === undefined ? internalQuickPanel : props.quickPanel;
  const onQuickPanelChange = props.onQuickPanelChange;
  const controlledQuickPanel = props.quickPanel !== undefined;
  const setQuickPanel = useCallback((panel: MeetingQuickPanel) => {
    if (!controlledQuickPanel) setInternalQuickPanel(panel);
    onQuickPanelChange?.(panel);
  }, [controlledQuickPanel, onQuickPanelChange]);
  // Keep the exit animation presentation-only; a replacement panel is never duplicated.
  const quickPresence = useExitPresence(quickPanel, 180);
  const quickPanelId = useId();
  const audioActionsRef = useRef<HTMLDivElement>(null);
  const shareActionsRef = useRef<HTMLDivElement>(null);
  const internalAudioTriggerRef = useRef<HTMLButtonElement>(null);
  const internalShareTriggerRef = useRef<HTMLButtonElement>(null);
  const audioTriggerRef = props.audioSettingsButtonRef ?? internalAudioTriggerRef;
  const shareTriggerRef = props.shareSettingsButtonRef ?? internalShareTriggerRef;
  const MicrophoneIcon = props.microphoneEnabled ? MicOff : Mic;
  useEffect(() => {
    if (quickPanel === null) return;
    const trigger = quickPanel === 'audio' ? audioTriggerRef.current : shareTriggerRef.current;
    const close = (returnFocus: boolean) => {
      setQuickPanel(null);
      if (returnFocus) queueMicrotask(() => trigger?.focus());
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      // Both split controls coordinate their own transitions without a stale close.
      if (audioActionsRef.current?.contains(event.target) || shareActionsRef.current?.contains(event.target)) return;
      const clickedFocusable = event.target instanceof Element && event.target.closest('button, a[href], input, select, textarea, [tabindex]');
      // Do not steal focus from the next action (More, Settings, or a page control).
      close(!clickedFocusable);
    };
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
    };
  }, [audioTriggerRef, quickPanel, setQuickPanel, shareTriggerRef]);
  const settingsProps = {
    ...props,
    microphoneDeviceId: props.microphoneDeviceId ?? microphoneDeviceId,
    speakerDeviceId: props.speakerDeviceId ?? speakerDeviceId,
    onMicrophoneDeviceChange: (deviceId: string) => { setMicrophoneDeviceId(deviceId); props.onMicrophoneDeviceChange(deviceId); },
    onSpeakerDeviceChange: (deviceId: string) => { setSpeakerDeviceId(deviceId); props.onSpeakerDeviceChange(deviceId); }
  };
  const renderQuickPanel = (panel: 'audio' | 'share') => quickPresence.value === panel && <div
    id={quickPanelId}
    className="meeting-volume-popover meeting-quick-popover"
    data-quick-panel={panel}
    data-state={quickPresence.exiting ? 'exiting' : 'open'}
    inert={quickPresence.exiting}
    aria-hidden={quickPresence.exiting || undefined}
    role="group"
    aria-label={t(panel === 'audio' ? 'controls.volumeQuickMenu' : 'controls.screenSettings')}
  >
    <MeetingSettings {...settingsProps} section={panel} />
  </div>;
  const mobileDockWrapped = Boolean(props.p2pRetryVisible && props.onP2pRetry);
  return <footer className={['meeting-controls', props.className].filter(Boolean).join(' ')} aria-label={t('controls.label')} data-mobile-wrapped={mobileDockWrapped ? 'true' : 'false'}>
    <div className="meeting-control-status">
      <p role="status"><span className="meeting-status-dot" aria-hidden="true" />{t('controls.connection', { state: props.connection })}</p>
      <p className="meeting-adaptive-quality">{t('controls.adaptiveQuality')}</p>
      {props.audioPlaybackBlocked && <button className="meeting-resume-audio" type="button" onClick={props.onResumeAudio}>{t('controls.resumeAudio')}</button>}
    </div>
    <p className="sr-only" role="status">{t('controls.microphoneStatus', { state: props.microphoneEnabled ? t('common.on') : t('common.muted') })}</p>
    <p className="sr-only" role="status">{t('controls.screenStatus', { state: props.screenShareActive ? t('common.on') : t('common.off') })}</p>
    <div className="meeting-primary-toolbar" role="toolbar" aria-label={t('controls.primaryToolbar')}>
      <div className="meeting-primary-actions" role="group" aria-label={t('controls.primaryActions')}>
        <div ref={audioActionsRef} className="meeting-split-control meeting-split-microphone">
          <button type="button" className="meeting-action meeting-action-microphone" aria-label={props.microphoneEnabled ? t('controls.mute') : t('controls.unmute')} onClick={props.onMicrophoneToggle} disabled={props.connection !== 'connected'}>
            <MicrophoneIcon aria-hidden="true" size={19} />
            <span className="meeting-label-full">{props.microphoneEnabled ? t('controls.mute') : t('controls.unmute')}</span>
            <span className="meeting-label-compact" aria-hidden="true">{props.microphoneEnabled ? t('controls.muteCompact') : t('controls.unmuteCompact')}</span>
          </button>
          <button
            ref={audioTriggerRef}
            type="button"
            className="meeting-action meeting-action-chevron"
            aria-label={t('controls.audioDevices')}
            title={t('controls.audioDevices')}
            aria-controls={quickPanelId}
            aria-expanded={quickPanel === 'audio'}
            onClick={() => setQuickPanel(quickPanel === 'audio' ? null : 'audio')}
          >{quickPanel === 'audio' ? <ChevronDown aria-hidden="true" size={16} /> : <ChevronUp aria-hidden="true" size={16} />}</button>
          {renderQuickPanel('audio')}
        </div>
        <div ref={shareActionsRef} className="meeting-split-control meeting-split-share">
          <button
            type="button"
            className="meeting-action meeting-action-share"
            data-active={props.screenShareActive ? 'true' : 'false'}
            aria-label={props.screenShareStopping ? t('controls.stoppingShare') : props.screenShareActive ? t('controls.stopShare') : t('controls.share')}
            title={props.screenShareAuthorized ? undefined : t('controls.shareGrantRequired')}
            disabled={!props.screenShareAuthorized || props.screenShareBusy || props.connection !== 'connected'}
            onClick={() => { setQuickPanel(null); props.onScreenShareToggle?.(); }}
          ><MonitorUp aria-hidden="true" size={19} /><span className="meeting-label-full">{props.screenShareStopping ? t('controls.stoppingShare') : props.screenShareActive ? t('controls.stopShareShort') : t('controls.shareShort')}</span><span className="meeting-label-compact" aria-hidden="true">{props.screenShareStopping ? t('controls.stoppingShareCompact') : props.screenShareActive ? t('controls.stopShareCompact') : t('controls.shareCompact')}</span></button>
          <button
            ref={shareTriggerRef}
            type="button"
            className="meeting-action meeting-action-share meeting-action-chevron"
            data-active={props.screenShareActive ? 'true' : 'false'}
            aria-label={t('controls.screenSettings')}
            title={t('controls.screenSettings')}
            aria-controls={quickPanelId}
            aria-expanded={quickPanel === 'share'}
            onClick={() => setQuickPanel(quickPanel === 'share' ? null : 'share')}
          >{quickPanel === 'share' ? <ChevronDown aria-hidden="true" size={16} /> : <ChevronUp aria-hidden="true" size={16} />}</button>
          {renderQuickPanel('share')}
        </div>
        {props.onMore && <button ref={props.moreButtonRef} type="button" className="meeting-action meeting-action-more" aria-label={t('controls.more')} onClick={() => { setQuickPanel(null); props.onMore?.(); }}><Ellipsis aria-hidden="true" size={20} /><span>{t('controls.more')}</span></button>}
        <button type="button" className="danger meeting-leave-action" aria-label={props.leaving ? t('controls.leaving') : t('controls.leave')} onClick={props.onLeave} disabled={props.leaving}>
          <LogOut aria-hidden="true" size={19} /><span>{props.leaving ? t('controls.leaving') : t('controls.leave')}</span>
        </button>
      </div>
      {props.p2pRetryVisible && props.onP2pRetry && <button type="button" className="secondary meeting-connection-retry" onClick={props.onP2pRetry}>{t('controls.p2pRetry')}</button>}
    </div>
    {(props.includeSettings ?? true) && <details className="meeting-settings">
      <summary>{t('controls.settings')}</summary>
      <MeetingSettings {...settingsProps} />
    </details>}
  </footer>;
}

function VolumeSlider({ label, displayLabel, kind, value, onChange }: { label: string; displayLabel?: string; kind: 'call' | 'shared'; value: number; onChange?: (volume: number) => void }) {
  const Icon = kind === 'shared' ? MonitorUp : Volume2;
  return <label className="meeting-volume-control" data-volume={kind}>
    <span className="meeting-volume-heading"><span>{displayLabel ?? label}</span><output>{value}%</output></span>
    <span className="meeting-volume-track">
      <Icon aria-hidden="true" size={19} />
      <input type="range" min="0" max="100" step="5" value={value} aria-label={label} onChange={(event) => onChange?.(Number(event.target.value))} />
    </span>
  </label>;
}

export interface MeetingSettingsProps extends MeetingControlsProps {
  section?: 'all' | 'audio' | 'share' | 'general';
}

export function MeetingSettings(props: MeetingSettingsProps) {
  const { t } = useI18n();
  const section = props.section ?? 'all';
  const [selectedMicrophone, setSelectedMicrophone] = useState('');
  const [selectedSpeaker, setSelectedSpeaker] = useState('');
  const audioHeadingId = useId();
  const receivingHeadingId = useId();
  const sharingHeadingId = useId();
  const qualityDescriptionId = useId();
  const quality = props.screenQuality ?? screenShareDefaultQuality;
  const microphoneDevices = props.devices.filter((device) => device.kind === 'audioinput');
  const speakerDevices = props.devices.filter((device) => device.kind === 'audiooutput');
  const screenShareProviderDisabled = Boolean(props.screenShareActive || props.screenShareBusy);
  const microphoneDeviceId = props.microphoneDeviceId ?? selectedMicrophone;
  const speakerDeviceId = props.speakerDeviceId ?? selectedSpeaker;
  const receivingSettings = props.viewerTransportPreferenceVisible && props.onViewerTransportPreferenceChange && <section className="meeting-settings-section" data-section="receiving" aria-labelledby={receivingHeadingId}>
    <h3 className="meeting-settings-section-heading" id={receivingHeadingId}>{t('controls.receivingScreen')}</h3>
    <div className="meeting-settings-section-grid">
      <label className="meeting-settings-field-wide">{t('controls.viewerTransport')}<select aria-label={t('controls.viewerTransport')} value={props.viewerTransportPreference ?? 'auto'} onChange={(event) => props.onViewerTransportPreferenceChange?.(event.target.value as ViewerTransportPreference)}>
        <option value="auto">{t('controls.viewerTransportAuto')}</option><option value="turn">{t('controls.viewerTransportTurn')}</option><option value="sfu">{t('controls.viewerTransportSfu')}</option>
      </select></label>
    </div>
  </section>;
  return <div className="meeting-settings-grid" data-settings-section={section}>
    {(section === 'all' || section === 'audio') && <section className="meeting-settings-section" data-section="audio" aria-labelledby={audioHeadingId}>
      <h3 className="meeting-settings-section-heading" id={audioHeadingId}>{t('controls.audioDevices')}</h3>
      <div className="meeting-settings-section-grid">
        <label className="meeting-device-control"><span><Mic aria-hidden="true" size={17} />{t('controls.microphoneDevice')}</span><select aria-label={t('controls.microphoneDevice')} value={microphoneDevices.some(device => device.deviceId === microphoneDeviceId) ? microphoneDeviceId : ''} onChange={(event) => { setSelectedMicrophone(event.target.value); props.onMicrophoneDeviceChange(event.target.value); }}>
          <option value="" disabled>{t('controls.selectMicrophone')}</option>
          {microphoneDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || t('controls.microphone')}</option>)}
        </select></label>
        <label className="meeting-device-control"><span><Volume2 aria-hidden="true" size={17} />{t('controls.speakerDevice')}</span><select aria-label={t('controls.speakerDevice')} value={speakerDevices.some(device => device.deviceId === speakerDeviceId) ? speakerDeviceId : ''} onChange={(event) => { setSelectedSpeaker(event.target.value); props.onSpeakerDeviceChange(event.target.value); }}>
          <option value="" disabled>{t('controls.selectSpeaker')}</option>
          {speakerDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || t('controls.speaker')}</option>)}
        </select></label>
        <VolumeSlider label={t('controls.callAudioVolume')} displayLabel={t('controls.callAudioShort')} kind="call" value={props.callAudioVolume ?? 100} onChange={props.onCallAudioVolumeChange} />
        {props.sharedAudioVolumeVisible && <VolumeSlider label={t('controls.sharedAudioVolume')} displayLabel={t('controls.sharedAudioShort')} kind="shared" value={props.sharedAudioVolume ?? 100} onChange={props.onSharedAudioVolumeChange} />}
      </div>
    </section>}
    {section === 'general' && receivingSettings}
    {section === 'general' && props.onOpenDiagnostics && <button className="meeting-settings-diagnostics secondary" type="button" onClick={props.onOpenDiagnostics}><Activity aria-hidden="true" size={17} />{t('controls.webrtcData')}</button>}
    {(section === 'all' || section === 'share') && <>
    <section className="meeting-settings-section" aria-label={t('controls.screenQuality')}>
      <h3 className="meeting-settings-section-heading">{t('controls.screenQuality')}</h3>
      <div className="meeting-settings-section-grid">
        <label className="meeting-settings-field-wide">{t('controls.screenQuality')}<select aria-label={t('controls.screenQuality')} aria-describedby={qualityDescriptionId} value={quality} disabled={props.screenShareActive || props.screenShareBusy} onChange={(event) => props.onScreenQualityChange?.(event.target.value as ScreenShareQuality)}>
          <option value="flow">{t('controls.flowShort')}</option><option value="standard">{t('controls.standardShort')}</option><option value="motion">{t('controls.motionShort')}</option><option value="detail60">{t('controls.detail60Short')}</option>
        </select><span id={qualityDescriptionId}>{t(`controls.${quality}`)}</span></label>
      </div>
      {screenShareProviderDisabled && <p className="meeting-settings-share-hint">{t('controls.sharingSettingsLocked')}</p>}
    </section>
    <details className="meeting-settings-advanced">
      <summary>{t('controls.advancedSettings')}<ChevronDown aria-hidden="true" size={18} /></summary>
      <p className="meeting-settings-advanced-hint">{t('controls.advancedSettingsHint')}</p>
    {section === 'all' && receivingSettings}
    <section className="meeting-settings-section" data-section="sharing" aria-labelledby={sharingHeadingId}>
      <h3 className="meeting-settings-section-heading" id={sharingHeadingId}>{t('controls.startingShare')}</h3>
      <div className="meeting-settings-section-grid">
        {props.onScreenSourceTransportChange && <label>{t('controls.screenSourceTransport')}<select aria-label={t('controls.screenSourceTransport')} value={props.screenSourceTransport ?? 'p2p'} disabled={screenShareProviderDisabled} onChange={event => props.onScreenSourceTransportChange?.(event.target.value as 'p2p' | 'cloudflare-sfu')}>
          <option value="p2p">{t('controls.screenSourceP2p')}</option><option value="cloudflare-sfu" disabled={props.cloudflareSfuAvailable === false}>{t('controls.screenSourceCloudflare')}</option>
        </select>{props.cloudflareSfuAvailable === false && <span>{t('controls.cloudflareSfuUnavailable')}</span>}{props.screenSourceTransport === 'cloudflare-sfu' && <span>{t('controls.cloudflareSfuEncodingHint')}</span>}</label>}
        <label>{t('controls.screenCodec')}<select aria-label={t('controls.screenCodec')} value={props.screenCodec ?? 'h264'} disabled={props.screenShareActive || props.screenShareBusy} onChange={(event) => props.onScreenCodecChange?.(event.target.value as ScreenShareCodec)}>
          <option value="h264">{t('controls.codecH264')}</option><option value="auto">{t('controls.codecAuto')}</option><option value="vp8">{t('controls.codecVp8')}</option>
        </select></label>
        <label>{t('controls.encodingEngine')}<select aria-label={t('controls.encodingEngine')} value={props.screenSourceTransport === 'cloudflare-sfu' ? 'browser' : props.screenEncodingEngine ?? 'browser'} disabled={props.screenSourceTransport === 'cloudflare-sfu' || props.screenShareActive || props.screenShareBusy} onChange={event => props.onScreenEncodingEngineChange?.(event.target.value as 'project' | 'browser')}>
          <option value="browser">{t('controls.browserEncoding')}</option><option value="project">{t('controls.projectEncoding')}</option>
        </select></label>
        <label className="meeting-settings-field-wide">{t('controls.screenBitrate')}<select aria-label={t('controls.screenBitrate')} value={props.screenBitrate ?? screenShareDefaultBitrate} disabled={props.screenShareActive || props.screenShareBusy} onChange={(event) => props.onScreenBitrateChange?.(Number(event.target.value) as ScreenShareBitrate)}>
          {screenShareBitrates.map((bitrate) => <option key={bitrate} value={bitrate}>{bitrate / 1_000_000} Mbps</option>)}
        </select><span className="meeting-controls-hint">{t('controls.p2pHint', { count: props.screenViewerCount ?? 0, bitrate: recommendP2pBitrate(props.screenViewerCount ?? 0) / 1_000_000 })}</span></label>
      </div>
    </section>
    </details>
    </>}
  </div>;
}
