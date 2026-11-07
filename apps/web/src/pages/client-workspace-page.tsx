import { ArrowRight, CircleHelp, Globe2, Link2, LockKeyhole, Monitor, Plus, RefreshCw, Settings2, Smartphone, Video } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { checkClientUpdate, useClientHost } from '../client/client-host.js';
import { useI18n } from '../i18n/i18n.js';
import { parseClientMeetingInput } from './client-meeting-input.js';
import { useOpenMeetings } from './use-open-meetings.js';
import './client-workspace-page.css';

const words = {
  en: {
    title: 'Meetings', intro: 'Join with a meeting link, or start a new conversation.',
    windows: 'Windows client', android: 'Android client', browser: 'Browser workspace',
    join: 'Join a meeting', inputLabel: 'Meeting link or ID', inputHint: 'Paste a Babagan invitation or enter its full meeting ID.',
    inputPlaceholder: 'Paste a meeting link or ID', joinButton: 'Join meeting', beforeJoin: 'You can choose your name and check your devices before joining.',
    inputError: 'Enter a valid meeting ID or a meeting link from this Babagan site.',
    create: 'Start a meeting', createDetail: 'Choose a name for your room, then share its invitation.', createButton: 'Create meeting',
    current: 'Open meetings', refresh: 'Refresh open meetings', loading: 'Looking for open meetings…',
    empty: 'No meeting is open right now', emptyDetail: 'Join using an invitation above, or create a room when you are ready.',
    lookupError: 'Open meetings could not be loaded.', retry: 'Try again',
    created: 'Ready to join', active: 'In progress', grace: 'Waiting for participants', password: 'Password required', full: 'Meeting full', enter: 'Open meeting',
    deviceHeading: 'This device', capabilityPending: 'Sharing capability not confirmed', capabilityPendingDetail: 'The client has not reported its sharing capabilities. You can still open a meeting to continue.',
    windowsCapture: 'Native Windows screen capture', windowsCaptureDetail: 'The client supports native capture. Your sharing session starts only when you choose to share in a meeting.',
    androidCapture: 'Android screen capture', androidFrameRate: 'up to', androidFps: 'fps', androidCaptureDetail: 'Choose a supported frame rate in meeting settings. Actual frame rate depends on your phone. Android asks for permission each time; system sound is not included.',
    browserCapture: 'Browser screen capture', browserCaptureDetail: 'Available sources and shared sound depend on your browser. Choose them when you start sharing.',
    unavailable: 'Screen capture is unavailable', unavailableDetail: 'This device has not reported screen-sharing support. Opening a meeting does not start capture.',
    updates: 'Client updates', version: 'Version', versionPending: 'Version not confirmed', checkUpdate: 'Check for updates',
    updateDetail: 'Downloads and installation wait until you leave the meeting.', windowsUpdateDetail: 'An installed update takes effect the next time you open the client.', androidUpdateDetail: 'Android may ask you to confirm installation when you are idle.',
    settings: 'Devices and preferences', settingsDevice: 'Choose your microphone, speakers and sharing options in the meeting settings.', settingsPermission: 'This workspace does not turn on your microphone, camera or screen sharing.', settingsLanguage: 'Change the interface language at the top of the window.', webUpdates: 'The web app loads updates when you open it again.',
  },
  'zh-CN': {
    title: '会议工作台', intro: '打开会议链接，或开始一场新会议。',
    windows: 'Windows 客户端', android: 'Android 客户端', browser: '浏览器工作台',
    join: '加入会议', inputLabel: '会议链接或 ID', inputHint: '粘贴收到的 Babagan 邀请链接，或输入完整会议 ID。',
    inputPlaceholder: '粘贴会议链接或 ID', joinButton: '加入会议', beforeJoin: '进入后可填写昵称、检查设备，再确认加入。',
    inputError: '请输入有效的会议 ID，或当前 Babagan 站点的会议链接。',
    create: '发起新会议', createDetail: '为会议起个名字，然后把邀请分享给其他人。', createButton: '创建会议',
    current: '开放中的会议', refresh: '刷新开放会议', loading: '正在查找开放会议…',
    empty: '目前没有开放的会议', emptyDetail: '可以在上方粘贴邀请加入，或准备好后创建会议。',
    lookupError: '暂时无法读取开放会议。', retry: '重试',
    created: '等待加入', active: '进行中', grace: '等待成员返回', password: '需要会议密码', full: '会议已满', enter: '进入会议',
    deviceHeading: '本机能力', capabilityPending: '共享能力尚未确认', capabilityPendingDetail: '客户端尚未返回共享能力信息。可以先打开会议，开始共享时再检查。',
    windowsCapture: 'Windows 本机屏幕采集', windowsCaptureDetail: '客户端支持本机采集。只有在会议里主动选择共享，才会开始采集画面。',
    androidCapture: 'Android 屏幕采集', androidFrameRate: '最高', androidFps: '帧', androidCaptureDetail: '支持的帧率可在会议设置中选择，实际帧率取决于手机性能。每次共享需系统授权；当前不包含系统声音。',
    browserCapture: '浏览器屏幕采集', browserCaptureDetail: '可选画面与声音由浏览器决定，开始共享时再选择。',
    unavailable: '屏幕采集暂不可用', unavailableDetail: '当前设备未报告屏幕共享支持。打开会议不会启动采集。',
    updates: '客户端更新', version: '版本', versionPending: '版本尚未确认', checkUpdate: '检查更新',
    updateDetail: '下载和安装会等待你离开会议后进行。', windowsUpdateDetail: '安装完成后，下次打开客户端时生效。', androidUpdateDetail: '空闲时 Android 可能会请你确认安装。',
    settings: '设备与偏好设置', settingsDevice: '麦克风、扬声器和共享选项，可在会议设置中调整。', settingsPermission: '此工作台不会自动打开麦克风、摄像头或屏幕共享。', settingsLanguage: '界面语言可在窗口顶部切换。', webUpdates: '重新打开网页时会加载新版应用。',
  },
} as const;

export function ClientWorkspacePage() {
  const { locale, t } = useI18n();
  const text = words[locale];
  const client = useClientHost();
  const navigate = useNavigate();
  const [meetingInput, setMeetingInput] = useState('');
  const [inputInvalid, setInputInvalid] = useState(false);
  const open = useOpenMeetings();
  const input = useRef<HTMLInputElement>(null);

  function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = parseClientMeetingInput(meetingInput, window.location.origin);
    if (!target) { setInputInvalid(true); input.current?.focus(); return; }
    setInputInvalid(false); navigate(target.path);
  }

  const platform = client.host?.platform;
  const info = client.info?.platform === platform ? client.info : undefined;
  const platformLabel = platform === 'windows' ? text.windows : platform === 'android' ? text.android : text.browser;
  const DeviceIcon = platform === 'windows' ? Monitor : platform === 'android' ? Smartphone : Globe2;
  let capability: string = text.capabilityPending;
  let capabilityDetail: string = text.capabilityPendingDetail;
  if (!platform) {
    const supported = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
    capability = supported ? text.browserCapture : text.unavailable;
    capabilityDetail = supported ? text.browserCaptureDetail : text.unavailableDetail;
  } else if (info) {
    const androidFrameRate = info.maxScreenFrameRate === 60 ? 60 : 30;
    capability = !info.screenCapture ? text.unavailable : platform === 'windows' ? text.windowsCapture : `${text.androidCapture} · ${text.androidFrameRate} ${androidFrameRate} ${text.androidFps}`;
    capabilityDetail = !info.screenCapture ? text.unavailableDetail : platform === 'windows' ? text.windowsCaptureDetail : text.androidCaptureDetail;
  }
  const updateBusy = client.joined || ['checking', 'downloading', 'installing'].includes(client.update);
  const updateLabel = client.joined && ['available', 'ready', 'downloading'].includes(client.update) ? t('client.update.deferred')
    : platform === 'android' && client.update === 'ready' ? t('client.update.readyAndroid') : t(`client.update.${client.update}`);

  return <main className="client-workspace" aria-labelledby="client-workspace-title">
    <header className="client-workspace-heading">
      <div><h1 id="client-workspace-title">{text.title}</h1><p>{text.intro}</p></div>
      <div className="client-workspace-tools">
        <span className="client-workspace-platform"><DeviceIcon size={16} aria-hidden="true" />{platformLabel}</span>
        {client.host && <div className="client-workspace-update-summary">
          <div className="client-workspace-update-text"><span>{info ? `${text.version} ${info.appVersion}` : text.versionPending}</span><p role="status">{updateLabel}</p></div>
          <button type="button" className="secondary" disabled={updateBusy} aria-busy={client.update === 'checking'} aria-describedby="client-update-policy" onClick={() => void checkClientUpdate()}><RefreshCw size={15} aria-hidden="true" />{text.checkUpdate}</button>
        </div>}
      </div>
    </header>

    <div className="client-workspace-grid">
      <section className="client-workspace-join" aria-labelledby="client-join-heading">
        <div className="client-workspace-section-title"><span className="client-workspace-icon"><Link2 size={22} aria-hidden="true" /></span><h2 id="client-join-heading">{text.join}</h2></div>
        <form onSubmit={join} noValidate>
          <label htmlFor="client-meeting-input">{text.inputLabel}</label>
          <div className="client-workspace-input-row">
            <input ref={input} id="client-meeting-input" value={meetingInput} onChange={event => { setMeetingInput(event.target.value); setInputInvalid(false); }}
              placeholder={text.inputPlaceholder} maxLength={2048} autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="go"
              aria-invalid={inputInvalid || undefined} aria-describedby={inputInvalid ? 'client-input-error' : 'client-input-hint'} />
            <button type="submit">{text.joinButton}<ArrowRight size={18} aria-hidden="true" /></button>
          </div>
          {inputInvalid ? <p id="client-input-error" className="client-workspace-error" role="alert">{text.inputError}</p>
            : <p id="client-input-hint" className="client-workspace-hint">{text.inputHint}</p>}
        </form>
        <p className="client-workspace-reassurance"><CircleHelp size={15} aria-hidden="true" />{text.beforeJoin}</p>
      </section>

      <section className="client-workspace-create" aria-labelledby="client-create-heading">
        <span className="client-workspace-icon"><Plus size={22} aria-hidden="true" /></span>
        <h2 id="client-create-heading">{text.create}</h2><p>{text.createDetail}</p>
        {open.atCapacity ? <><button type="button" className="client-workspace-create-button" disabled><Plus size={17} aria-hidden="true" />{text.createButton}</button><p className="client-workspace-capacity-note">{t('error.MEETING_LIMIT_REACHED')}</p></>
          : <Link className="client-workspace-create-button" to="/create"><Plus size={17} aria-hidden="true" />{text.createButton}</Link>}
      </section>

      <section className="client-workspace-current" aria-labelledby="client-current-heading" aria-busy={open.loading}>
        <div className="client-workspace-panel-heading"><div><h2 id="client-current-heading">{text.current}</h2>{open.loaded && <p className="client-workspace-capacity">{t('open.capacity', { count: open.meetings.length, max: open.maxOpenMeetings })}</p>}</div>
          <button type="button" className="client-workspace-icon-button" aria-label={text.refresh} title={text.refresh} disabled={open.loading} onClick={() => void open.refresh()}><RefreshCw size={17} aria-hidden="true" /></button>
        </div>
        {open.loading && !open.loaded && <p className="client-workspace-loading" role="status">{text.loading}</p>}
        {open.loaded && !open.meetings.length && <div className="client-workspace-empty"><Video size={28} aria-hidden="true" /><h3>{text.empty}</h3><p>{text.emptyDetail}</p></div>}
        {open.failed && <div className="client-workspace-load-error"><p role="alert">{text.lookupError}</p><button type="button" className="secondary" onClick={() => void open.refresh()}>{text.retry}</button></div>}
        {open.meetings.map(meeting => <article className="client-workspace-meeting" key={meeting.slug} aria-label={meeting.name}>
          <div className="client-workspace-meeting-info"><span className="client-workspace-meeting-state">{text[meeting.status]}</span><h3>{meeting.name}</h3>
            {meeting.requiresPassword && <p><LockKeyhole size={14} aria-hidden="true" />{text.password}</p>}
            {meeting.unavailable && <p>{t('open.unavailableHint')}</p>}
          </div>
          {meeting.unavailable || meeting.isFull ? <button type="button" className="secondary" disabled>{meeting.unavailable ? t('open.unavailable') : text.full}</button>
            : <Link className="client-workspace-meeting-link" to={`/m/${meeting.slug}`}>{text.enter}<ArrowRight size={17} aria-hidden="true" /></Link>}
        </article>)}
      </section>

      <aside className="client-workspace-device" aria-labelledby="client-device-heading">
        <h2 id="client-device-heading">{text.deviceHeading}</h2>
        <div className="client-workspace-capability"><DeviceIcon size={21} aria-hidden="true" /><div><h3>{capability}</h3><p>{capabilityDetail}</p></div></div>
        {client.host ? <section className="client-workspace-updates" aria-labelledby="client-updates-heading">
          <h3 id="client-updates-heading">{text.updates}</h3>
          <p id="client-update-policy" className="client-workspace-update-note">{text.updateDetail} {platform === 'windows' ? text.windowsUpdateDetail : text.androidUpdateDetail}</p>
        </section> : <p className="client-workspace-web-updates">{text.webUpdates}</p>}
        <details className="client-workspace-settings"><summary><Settings2 size={16} aria-hidden="true" />{text.settings}</summary>
          <p>{text.settingsDevice}</p><p>{text.settingsLanguage}</p><p>{text.settingsPermission}</p>
        </details>
      </aside>
    </div>
  </main>;
}
