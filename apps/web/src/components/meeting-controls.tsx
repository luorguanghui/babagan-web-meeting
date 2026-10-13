import type { P2pTurnProvider, ScreenShareCodec, ScreenShareQuality } from '@meeting/contracts';
import { ChevronDown, ChevronUp, Ellipsis, LogOut, Mic, MicOff, MonitorUp, Volume2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';

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

export interface MeetingControlsProps {
  className?: string;
  connection: MeetingConnectionState;
  microphoneEnabled: boolean;
  audioPlaybackBlocked: boolean;
  callAudioVolume?: number;
  sharedAudioVolume?: number;
  sharedAudioVolumeVisible?: boolean;
  devices: MediaDeviceInfo[];
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
  onLeave: () => void;
}

export function MeetingControls(props: MeetingControlsProps) {
  const { t } = useI18n();
  const [volumePanel, setVolumePanel] = useState<'call' | 'shared' | null>(null);
  // Allow one paint before the 140 ms CSS exit finishes.
  const volumePresence = useExitPresence(volumePanel, 180);
  const volumePanelId = useId();
  const volumeActionsRef = useRef<HTMLDivElement>(null);
  const volumeTriggerRef = useRef<HTMLButtonElement>(null);
  const MicrophoneIcon = props.microphoneEnabled ? MicOff : Mic;
  useEffect(() => {
    if (volumePanel === 'shared' && !props.sharedAudioVolumeVisible) setVolumePanel(null);
  }, [props.sharedAudioVolumeVisible, volumePanel]);
  useEffect(() => {
    if (volumePanel === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        const trigger = volumeTriggerRef.current;
        setVolumePanel(null);
        queueMicrotask(() => trigger?.focus());
      }
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !volumeActionsRef.current?.contains(event.target)) setVolumePanel(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
    };
  }, [volumePanel]);
  const openVolumePanel = (panel: 'call' | 'shared', trigger: HTMLButtonElement) => {
    volumeTriggerRef.current = trigger;
    setVolumePanel((current) => current === panel ? null : panel);
  };
  const combinedVolumeEntry = props.includeSettings === false;
  const mobileDockWrapped = Boolean((!combinedVolumeEntry && props.sharedAudioVolumeVisible) || (props.p2pRetryVisible && props.onP2pRetry));
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
        <button type="button" className="meeting-action meeting-action-microphone" onClick={props.onMicrophoneToggle} disabled={props.connection !== 'connected'}>
          <MicrophoneIcon aria-hidden="true" size={19} />
          <span>{props.microphoneEnabled ? t('controls.mute') : t('controls.unmute')}</span>
        </button>
        <div ref={volumeActionsRef} className="meeting-volume-actions" data-combined-volume={combinedVolumeEntry ? 'true' : 'false'}>
          <div className="meeting-volume-button-row">
            <button
              type="button"
              className="meeting-action meeting-action-volume"
              aria-controls={volumePanelId}
              aria-expanded={volumePanel !== null}
              onClick={(event) => openVolumePanel('call', event.currentTarget)}
              aria-label={combinedVolumeEntry ? t('controls.volume') : t('controls.callAudioVolume')}
            ><Volume2 aria-hidden="true" size={19} /><span>{combinedVolumeEntry ? t('controls.volume') : t('controls.callAudioShort')}</span>{volumePanel === 'call' ? <ChevronDown aria-hidden="true" size={16} /> : <ChevronUp aria-hidden="true" size={16} />}</button>
            {!combinedVolumeEntry && props.sharedAudioVolumeVisible && <button
              type="button"
              className="meeting-action meeting-action-volume meeting-action-shared-volume"
              aria-controls={volumePanelId}
              aria-expanded={volumePanel !== null}
              onClick={(event) => openVolumePanel('shared', event.currentTarget)}
              aria-label={t('controls.sharedAudioVolume')}
            ><Volume2 aria-hidden="true" size={19} /><span>{t('controls.sharedAudioShort')}</span>{volumePanel === 'shared' ? <ChevronDown aria-hidden="true" size={16} /> : <ChevronUp aria-hidden="true" size={16} />}</button>}
          </div>
          {volumePresence.value !== null && <div
            id={volumePanelId}
            className="meeting-volume-popover"
            data-state={volumePresence.exiting ? 'exiting' : 'open'}
            inert={volumePresence.exiting}
            aria-hidden={volumePresence.exiting || undefined}
            role="group"
            aria-label={t('controls.volumeQuickMenu')}
          >
            <div className="meeting-volume-popover-heading">
              <span>{t('controls.volumeQuickMenu')}</span>
              {!combinedVolumeEntry && <span className="meeting-volume-popover-hint">{volumePresence.value === 'shared' && props.sharedAudioVolumeVisible ? t('controls.sharedAudioVolume') : t('controls.callAudioVolume')}</span>}
            </div>
            <VolumeSlider label={t('controls.callAudioVolume')} displayLabel={t('controls.callAudioShort')} kind="call" value={props.callAudioVolume ?? 100} onChange={props.onCallAudioVolumeChange} />
            {props.sharedAudioVolumeVisible && <VolumeSlider label={t('controls.sharedAudioVolume')} displayLabel={t('controls.sharedAudioShort')} kind="shared" value={props.sharedAudioVolume ?? 100} onChange={props.onSharedAudioVolumeChange} />}
          </div>}
        </div>
        <button
          type="button"
          className="meeting-action meeting-action-share"
          data-active={props.screenShareActive ? 'true' : 'false'}
          aria-label={props.screenShareStopping ? t('controls.stoppingShare') : props.screenShareActive ? t('controls.stopShare') : t('controls.share')}
          title={props.screenShareAuthorized ? undefined : t('controls.shareGrantRequired')}
          disabled={!props.screenShareAuthorized || props.screenShareBusy || props.connection !== 'connected'}
          onClick={props.onScreenShareToggle}
        ><MonitorUp aria-hidden="true" size={19} /><span>{props.screenShareStopping ? t('controls.stoppingShare') : props.screenShareActive ? t('controls.stopShareShort') : t('controls.shareShort')}</span></button>
        {props.p2pRetryVisible && props.onP2pRetry && <button type="button" className="secondary" onClick={props.onP2pRetry}>{t('controls.p2pRetry')}</button>}
        {props.onMore && <button ref={props.moreButtonRef} type="button" className="meeting-action meeting-action-more" onClick={props.onMore}><Ellipsis aria-hidden="true" size={20} /><span>{t('controls.more')}</span></button>}
        <button type="button" className="danger meeting-leave-action" onClick={props.onLeave} disabled={props.leaving}>
          <LogOut aria-hidden="true" size={19} /><span>{props.leaving ? t('controls.leaving') : t('controls.leave')}</span>
        </button>
      </div>
    </div>
    {(props.includeSettings ?? true) && <details className="meeting-settings">
      <summary>{t('controls.settings')}</summary>
      <MeetingSettings {...props} />
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

export function MeetingSettings(props: MeetingControlsProps) {
  const { t } = useI18n();
  const audioHeadingId = useId();
  const receivingHeadingId = useId();
  const sharingHeadingId = useId();
  const microphoneDevices = props.devices.filter((device) => device.kind === 'audioinput');
  const speakerDevices = props.devices.filter((device) => device.kind === 'audiooutput');
  const screenShareProviderDisabled = Boolean(props.screenShareActive || props.screenShareBusy);
  return <div className="meeting-settings-grid">
    <section className="meeting-settings-section" data-section="audio" aria-labelledby={audioHeadingId}>
      <h3 className="meeting-settings-section-heading" id={audioHeadingId}>{t('controls.audioDevices')}</h3>
      <div className="meeting-settings-section-grid">
        <VolumeSlider label={t('controls.callAudioVolume')} displayLabel={t('controls.callAudioShort')} kind="call" value={props.callAudioVolume ?? 100} onChange={props.onCallAudioVolumeChange} />
        {props.sharedAudioVolumeVisible && <VolumeSlider label={t('controls.sharedAudioVolume')} displayLabel={t('controls.sharedAudioShort')} kind="shared" value={props.sharedAudioVolume ?? 100} onChange={props.onSharedAudioVolumeChange} />}
        <label>{t('controls.microphoneDevice')}<select aria-label={t('controls.microphoneDevice')} defaultValue="" onChange={(event) => props.onMicrophoneDeviceChange(event.target.value)}>
          <option value="" disabled>{t('controls.selectMicrophone')}</option>
          {microphoneDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || t('controls.microphone')}</option>)}
        </select></label>
        <label>{t('controls.speakerDevice')}<select aria-label={t('controls.speakerDevice')} defaultValue="" onChange={(event) => props.onSpeakerDeviceChange(event.target.value)}>
          <option value="" disabled>{t('controls.selectSpeaker')}</option>
          {speakerDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || t('controls.speaker')}</option>)}
        </select></label>
      </div>
    </section>
    {props.viewerTransportPreferenceVisible && props.onViewerTransportPreferenceChange && <section className="meeting-settings-section" data-section="receiving" aria-labelledby={receivingHeadingId}>
      <h3 className="meeting-settings-section-heading" id={receivingHeadingId}>{t('controls.receivingScreen')}</h3>
      <div className="meeting-settings-section-grid">
        <label className="meeting-settings-field-wide">{t('controls.viewerTransport')}<select aria-label={t('controls.viewerTransport')} value={props.viewerTransportPreference ?? 'auto'} onChange={(event) => props.onViewerTransportPreferenceChange?.(event.target.value as ViewerTransportPreference)}>
          <option value="auto">{t('controls.viewerTransportAuto')}</option><option value="turn">{t('controls.viewerTransportTurn')}</option><option value="sfu">{t('controls.viewerTransportSfu')}</option>
        </select></label>
      </div>
    </section>}
    <section className="meeting-settings-section" data-section="sharing" aria-labelledby={sharingHeadingId}>
      <h3 className="meeting-settings-section-heading" id={sharingHeadingId}>{t('controls.startingShare')}</h3>
      <div className="meeting-settings-section-grid">
        {props.onScreenSourceTransportChange && <label>{t('controls.screenSourceTransport')}<select aria-label={t('controls.screenSourceTransport')} value={props.screenSourceTransport ?? 'p2p'} disabled={screenShareProviderDisabled} onChange={event => props.onScreenSourceTransportChange?.(event.target.value as 'p2p' | 'cloudflare-sfu')}>
          <option value="p2p">{t('controls.screenSourceP2p')}</option><option value="cloudflare-sfu" disabled={props.cloudflareSfuAvailable === false}>{t('controls.screenSourceCloudflare')}</option>
        </select>{props.cloudflareSfuAvailable === false && <span>{t('controls.cloudflareSfuUnavailable')}</span>}{props.screenSourceTransport === 'cloudflare-sfu' && <span>{t('controls.cloudflareSfuEncodingHint')}</span>}</label>}
        <label>{t('controls.screenQuality')}<select aria-label={t('controls.screenQuality')} value={props.screenQuality ?? screenShareDefaultQuality} disabled={props.screenShareActive || props.screenShareBusy} onChange={(event) => props.onScreenQualityChange?.(event.target.value as ScreenShareQuality)}>
          <option value="flow">{t('controls.flow')}</option><option value="standard">{t('controls.standard')}</option><option value="motion">{t('controls.motion')}</option><option value="detail60">{t('controls.detail60')}</option>
        </select></label>
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
      <p className="meeting-settings-share-hint">{t('controls.sharingSettingsLocked')}</p>
    </section>
  </div>;
}
