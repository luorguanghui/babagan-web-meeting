import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

export type Locale = 'en' | 'zh-CN';
type Params = Record<string, string | number>;
type Message = string | ((params: Params) => string);

const en = {
  'language.label': 'Language',
  'language.en': 'English',
  'language.zh-CN': '简体中文',
  'create.eyebrow': 'Private web meeting',
  'create.heading': 'Create a meeting',
  'create.lede': 'Set up a small, short-lived room. Your admin password stays on this device only long enough to create it.',
  'create.name': 'Meeting name',
  'create.adminPassword': 'Admin password',
  'create.meetingPassword': 'Meeting password',
  'common.optional': 'optional',
  'create.submit': 'Create meeting',
  'create.submitting': 'Creating…',
  'create.nameRequired': 'Meeting name is required.',
  'create.adminRequired': 'Admin password is required.',
  'create.passwordLength': 'Meeting password must be at least 6 characters.',
  'create.failed': 'The meeting could not be created.',
  'create.copyFailed': 'Copy the link manually.',
  'create.linkRegion': 'Meeting link',
  'create.shareLink': 'Share this link',
  'create.enterHost': 'Enter as host',
  'create.copyLink': 'Copy link',
  'create.copied': 'Link copied.',
  'current.eyebrow': 'Open room',
  'current.heading': 'Current meeting',
  'current.status.created': 'Waiting for participants',
  'current.status.active': 'In progress',
  'current.status.grace': 'Temporarily empty',
  'current.passwordRequired': 'Password required',
  'current.noPassword': 'No meeting password',
  'current.full': 'Room full',
  'current.join': 'Join current meeting',
  'current.lookupFailed': 'The current meeting could not be loaded.',
  'current.retry': 'Retry',
  'adminEnd.heading': 'End with administrator password',
  'adminEnd.password': 'Admin password to end meeting',
  'adminEnd.passwordRequired': 'Admin password is required.',
  'adminEnd.end': 'End current meeting',
  'adminEnd.ending': 'Ending…',
  'adminEnd.failed': 'The meeting could not be ended.',
  'join.eyebrow': 'Meeting lobby',
  'join.heading': 'Ready when you are',
  'join.lede': 'Choose a name, check your audio if you like, then enter with your microphone muted.',
  'join.nickname': 'Nickname',
  'join.password': 'Meeting password',
  'join.ifRequired': 'if required',
  'join.submit': 'Join muted',
  'join.submitting': 'Joining…',
  'join.nicknameRequired': 'Nickname is required.',
  'join.passwordRequired': 'Meeting password is required.',
  'join.required': 'required',
  'join.failed': 'The meeting could not be joined.',
  'join.secureRequired': 'Join from a secure HTTPS connection to use this meeting.',
  'join.webrtcUnavailable': 'WebRTC is unavailable in this browser. Use a current Chrome or Edge browser.',
  'join.mobileNotice': 'Mobile is available for view and voice only; screen sharing is not supported.',
  'join.unsupported': 'This release is supported on Windows 10 or 11 with Chrome or Edge. Please join from a supported computer.',
  'device.heading': 'Device check',
  'device.description': 'Checking your microphone is optional. It never starts before you choose it.',
  'device.checkMicrophone': 'Check microphone',
  'device.testSpeaker': 'Test speaker',
  'device.level': 'Microphone level',
  'device.off': 'Microphone is off until you check it.',
  'device.unavailable': 'This browser or device policy does not expose microphone access. Use a current Windows Chrome or Edge browser and allow microphone access.',
  'device.ready': 'Microphone preview is ready.',
  'device.denied': 'Microphone permission was denied. Allow it in your browser settings and try again.',
  'device.failed': 'Microphone preview could not start. Check your microphone and try again.',
  'device.speakerUnavailable': 'Speaker test is unavailable in this browser.',
  'device.playing': 'Playing a short speaker test.',
  'error.heading': 'Something went wrong',
  'error.retry': 'Please return to the meeting link and try again.',
  'error.supportId': ({ id }) => `Support ID: ${id}`,
  'error.generic': 'The request could not be completed. Please try again.',
  'error.MEETING_NOT_FOUND': 'This meeting does not exist.',
  'error.MEETING_EXPIRED': 'This meeting has expired.',
  'error.MEETING_FULL': 'This meeting is full.',
  'error.INVALID_MEETING_PASSWORD': 'The meeting password is incorrect.',
  'error.ADMIN_AUTH_FAILED': 'Authentication failed.',
  'error.SHARE_ALREADY_ACTIVE': 'Someone is already sharing a screen.',
  'error.SHARE_NOT_AUTHORIZED': 'The host has not authorized screen sharing.',
  'error.UNSUPPORTED_CLIENT': 'This browser is not supported.',
  'error.RATE_LIMITED': 'Too many requests. Please try again shortly.',
  'error.MEDIA_SERVICE_UNAVAILABLE': 'The meeting media service is temporarily unavailable.',
  'room.eyebrow': 'Meeting room',
  'room.heading': ({ name }) => `${name}, you are in`,
  'room.sidePanel': 'Meeting side panel',
  'room.management': 'Meeting management',
  'room.devicesFailed': 'Audio devices could not be listed.',
  'room.leaveUnconfirmed': 'The server could not confirm that you left.',
  'room.speakerUnsupported': 'This browser does not support speaker switching.',
  'room.shareFailed': 'Screen sharing could not be started. Check that the host grant is still active.',
  'connection.offline': 'You are offline. Reconnecting when your connection returns.',
  'connection.connected': 'Connected',
  'connection.refreshing': 'Refreshing your secure meeting connection…',
  'connection.reconnecting': 'Reconnecting to the meeting…',
  'connection.busy': 'The service is busy. Retrying your meeting connection shortly…',
  'connection.rejoin': 'Your connection could not be restored. Please rejoin the meeting.',
  'connection.ended': 'This meeting has ended or expired.',
  'controls.label': 'Meeting controls',
  'controls.primaryActions': 'Primary meeting actions',
  'controls.settings': 'Audio and sharing settings',
  'controls.adaptiveQuality': 'Adaptive screen share · 30–60 fps',
  'controls.connection': ({ state }) => `Connection: ${state}`,
  'controls.microphoneStatus': ({ state }) => `Microphone is ${state}.`,
  'controls.screenStatus': ({ state }) => `Screen sharing is ${state}.`,
  'common.on': 'on',
  'common.off': 'off',
  'common.muted': 'muted',
  'controls.mute': 'Mute microphone',
  'controls.unmute': 'Unmute microphone',
  'controls.microphoneDevice': 'Microphone device',
  'controls.selectMicrophone': 'Select microphone',
  'controls.microphone': 'Microphone',
  'controls.speakerDevice': 'Speaker device',
  'controls.selectSpeaker': 'Select speaker',
  'controls.speaker': 'Speaker',
  'controls.resumeAudio': 'Click to resume audio',
  'controls.screenQuality': 'Screen quality',
  'controls.flow': 'Flow (720p30, resolution first)',
  'controls.standard': 'Standard (1080p30, resolution first)',
  'controls.motion': 'Motion (1080p60, resolution first)',
  'controls.screenBitrate': 'Maximum screen-share bitrate',
  'controls.p2pHint': ({ count, bitrate }) => count === 0
    ? 'Choose the P2P bitrate cap per viewer; a total uplink budget protects the connection.'
    : `Suggested P2P bitrate cap per viewer: ${bitrate} Mbps for ${count} online viewer${count === 1 ? '' : 's'}.`,
  'controls.p2pRetry': 'Retry direct connection',
  'controls.screenCodec': 'Screen-share codec',
  'controls.codecH264': 'H.264',
  'controls.codecAuto': 'Auto',
  'controls.codecVp8': 'VP8',
  'screenTransport.p2p': 'Direct P2P',
  'screenTransport.turn': 'TURN relay',
  'screenTransport.sfu': 'SFU relay',
  'screenTransport.mixed': 'Mixed mode',
  'screenTransport.negotiating': 'Connecting',
  'screenTransport.waiting': 'Waiting for viewers',
  'stats.heading': 'WebRTC statistics',
  'stats.requestedCodec': 'Requested codec',
  'stats.collecting': 'Collecting statistics…',
  'stats.sender': 'Sender',
  'stats.receiver': 'Receiver',
  'stats.codec': 'Negotiated codec',
  'stats.resolution': 'Resolution',
  'stats.fps': 'Frame rate',
  'stats.bitrate': 'Bitrate',
  'stats.packetLoss': 'Lost packets',
  'stats.rtt': 'Round-trip time',
  'stats.droppedFrames': 'Dropped frames',
  'stats.freezes': 'Freezes',
  'stats.encodeTime': 'Average encode time',
  'stats.jitter': 'Jitter',
  'stats.jitterBuffer': 'Average jitter buffer',
  'stats.bandwidth': 'Available outgoing bandwidth',
  'stats.limitation': 'Quality limitation',
  'controls.share': 'Share screen',
  'controls.stopShare': 'Stop sharing screen',
  'controls.shareShort': 'Share screen',
  'controls.stopShareShort': 'Stop sharing',
  'controls.shareGrantRequired': 'A host must grant screen sharing before capture can start.',
  'controls.leave': 'Leave meeting',
  'controls.leaving': 'Leaving…',
  'participants.heading': ({ count }) => `Participants (${count})`,
  'participants.label': 'Participants',
  'participants.you': 'You',
  'participants.youLabel': 'you',
  'participants.microphoneOn': 'Microphone on',
  'participants.microphoneMuted': 'microphone muted',
  'participants.muted': 'Muted',
  'participants.itemLabel': ({ name, you, microphone }) => `${name}${you ? ', you' : ''}, ${microphone}`,
  'host.heading': 'Host controls',
  'host.listLabel': 'Host participant controls',
  'host.failed': 'The host action could not be completed.',
  'host.revoke': ({ name }) => `Revoke screen sharing from ${name}`,
  'host.grant': ({ name }) => `Grant screen sharing to ${name}`,
  'host.kick': ({ name }) => `Kick ${name}`,
  'host.end': 'End meeting',
  'host.ending': 'Ending meeting…',
  'host.confirmEnd': 'End this meeting for everyone?',
  'screen.stage': 'Shared screen stage',
  'screen.empty': 'No screen is being shared.',
  'screen.participant': 'Participant',
  'screen.videoLabel': ({ name }) => `${name}'s shared screen`,
  'screen.fullscreen': 'View shared screen fullscreen',
  'screen.fullscreenAction': 'Full screen',
  'screen.noAudio': 'No computer audio was shared. In Chrome or Edge, choose a browser tab and enable “Share tab audio”, or choose Entire screen and enable system audio in the share picker.',
  'screen.videoOnly': 'The screen is being shared without computer audio because the browser could not prevent meeting echo.',
  'screen.echoRisk': 'The browser could not isolate meeting playback from system audio. You chose to continue with the echo risk.',
  'screen.chooseTab': 'Screen sharing was cancelled. Choose a browser tab and enable “Share tab audio” for isolated content audio.',
  'audioWarning.heading': 'System audio echo protection',
  'audioWarning.description': ({ surface }) => `This browser could not confirm that meeting voices will be removed from the captured ${surface} audio. Choose how to continue.`,
  'audioWarning.videoOnly': 'Share without computer audio',
  'audioWarning.continue': 'Continue with system audio',
  'audioWarning.cancel': 'Cancel and choose a browser tab'
} satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;

const zhCN: Record<MessageKey, Message> = {
  ...en,
  'language.label': '语言', 'language.en': 'English', 'language.zh-CN': '简体中文',
  'create.eyebrow': '私密网页会议', 'create.heading': '创建会议', 'create.lede': '创建一个小型、短期使用的会议室。管理员密码只会在创建时保留在此设备上。',
  'create.name': '会议名称', 'create.adminPassword': '管理员密码', 'create.meetingPassword': '会议密码', 'common.optional': '可选',
  'create.submit': '创建会议', 'create.submitting': '正在创建…', 'create.nameRequired': '请输入会议名称。', 'create.adminRequired': '请输入管理员密码。',
  'create.passwordLength': '会议密码至少需要 6 个字符。', 'create.failed': '无法创建会议。', 'create.copyFailed': '请手动复制链接。',
  'create.linkRegion': '会议链接', 'create.shareLink': '分享此链接', 'create.enterHost': '以主持人身份进入', 'create.copyLink': '复制链接', 'create.copied': '链接已复制。',
  'current.eyebrow': '已开启的会议', 'current.heading': '当前会议', 'current.status.created': '等待成员加入', 'current.status.active': '进行中',
  'current.status.grace': '暂时无人在线', 'current.passwordRequired': '需要会议密码', 'current.noPassword': '无需会议密码', 'current.full': '会议已满',
  'current.join': '加入当前会议', 'current.lookupFailed': '无法加载当前会议。', 'current.retry': '重试',
  'adminEnd.heading': '使用管理员密码结束会议', 'adminEnd.password': '用于结束会议的管理员密码', 'adminEnd.passwordRequired': '请输入管理员密码。',
  'adminEnd.end': '结束当前会议', 'adminEnd.ending': '正在结束…', 'adminEnd.failed': '无法结束会议。',
  'join.eyebrow': '会议大厅', 'join.heading': '准备好即可加入', 'join.lede': '填写昵称，可按需检查音频，然后以麦克风静音状态进入。',
  'join.nickname': '昵称', 'join.password': '会议密码', 'join.ifRequired': '如会议要求', 'join.submit': '静音加入', 'join.submitting': '正在加入…',
  'join.nicknameRequired': '请输入昵称。', 'join.passwordRequired': '请输入会议密码。', 'join.required': '必填', 'join.failed': '无法加入会议。', 'join.secureRequired': '请通过安全的 HTTPS 连接加入会议。',
  'join.webrtcUnavailable': '此浏览器无法使用 WebRTC，请使用最新版 Chrome 或 Edge。', 'join.mobileNotice': '移动设备仅支持观看和语音，不支持屏幕共享。',
  'join.unsupported': '当前版本支持 Windows 10 或 11 上的 Chrome 或 Edge，请使用受支持的电脑加入。',
  'device.heading': '设备检查', 'device.description': '麦克风检查是可选的，只有点击后才会启用。', 'device.checkMicrophone': '检查麦克风', 'device.testSpeaker': '测试扬声器',
  'device.level': '麦克风音量', 'device.off': '麦克风保持关闭，直到你主动检查。', 'device.unavailable': '浏览器或设备策略未开放麦克风权限，请使用 Windows 版 Chrome 或 Edge 并允许访问麦克风。',
  'device.ready': '麦克风预览已就绪。', 'device.denied': '麦克风权限被拒绝，请在浏览器设置中允许后重试。', 'device.failed': '无法启动麦克风预览，请检查设备后重试。',
  'device.speakerUnavailable': '此浏览器无法进行扬声器测试。', 'device.playing': '正在播放短测试音。',
  'error.heading': '出现错误', 'error.retry': '请返回会议链接后重试。', 'error.supportId': ({ id }) => `支持编号：${id}`, 'error.generic': '操作未能完成，请重试。',
  'error.MEETING_NOT_FOUND': '会议不存在。', 'error.MEETING_EXPIRED': '会议已过期。', 'error.MEETING_FULL': '会议人数已满。', 'error.INVALID_MEETING_PASSWORD': '会议密码不正确。',
  'error.ADMIN_AUTH_FAILED': '管理员密码不正确。', 'error.SHARE_ALREADY_ACTIVE': '当前已有成员正在共享屏幕。', 'error.SHARE_NOT_AUTHORIZED': '主持人尚未授权屏幕共享。',
  'error.UNSUPPORTED_CLIENT': '当前浏览器不受支持。', 'error.RATE_LIMITED': '请求过于频繁，请稍后重试。', 'error.MEDIA_SERVICE_UNAVAILABLE': '会议媒体服务暂时不可用。',
  'room.eyebrow': '会议室', 'room.heading': ({ name }) => `${name}，你已进入会议`, 'room.sidePanel': '会议侧栏', 'room.management': '会议管理', 'room.devicesFailed': '无法获取音频设备列表。',
  'room.leaveUnconfirmed': '服务器未能确认你已离开。', 'room.speakerUnsupported': '此浏览器不支持切换扬声器。', 'room.shareFailed': '无法开始屏幕共享，请确认主持人的授权仍然有效。',
  'connection.offline': '网络已断开，恢复后将自动重连。', 'connection.connected': '已连接', 'connection.refreshing': '正在刷新安全会议连接…',
  'connection.reconnecting': '正在重新连接会议…', 'connection.busy': '服务繁忙，稍后将重试连接…', 'connection.rejoin': '无法恢复连接，请重新加入会议。', 'connection.ended': '会议已结束或过期。',
  'controls.label': '会议控制', 'controls.primaryActions': '主要会议操作', 'controls.settings': '音频与共享设置', 'controls.adaptiveQuality': '自适应屏幕共享 · 30–60 帧', 'controls.connection': ({ state }) => `连接状态：${state}`, 'controls.microphoneStatus': ({ state }) => `麦克风${state}。`,
  'controls.screenStatus': ({ state }) => `屏幕共享${state}。`, 'common.on': '已开启', 'common.off': '已关闭', 'common.muted': '已静音',
  'controls.mute': '静音麦克风', 'controls.unmute': '开启麦克风', 'controls.microphoneDevice': '麦克风设备', 'controls.selectMicrophone': '选择麦克风',
  'controls.microphone': '麦克风', 'controls.speakerDevice': '扬声器设备', 'controls.selectSpeaker': '选择扬声器', 'controls.speaker': '扬声器', 'controls.resumeAudio': '点击恢复声音',
  'controls.screenQuality': '共享画质', 'controls.flow': '流畅（720p30，分辨率优先）', 'controls.standard': '标准（1080p30，分辨率优先）', 'controls.motion': '动态（1080p60，分辨率优先）', 'controls.screenBitrate': '共享最高码率', 'controls.p2pHint': ({ count, bitrate }) => count === 0 ? '请选择每名观看者的 P2P 码率上限；总上行预算将自动保护连接质量。' : `建议每名观看者的 P2P 码率上限为 ${bitrate} Mbps（当前 ${count} 名在线观看者）。`, 'controls.p2pRetry': '重试 P2P 直连', 'controls.screenCodec': '共享编码', 'controls.codecH264': 'H.264', 'controls.codecAuto': '自动', 'controls.codecVp8': 'VP8', 'screenTransport.p2p': 'P2P 直连', 'screenTransport.turn': 'TURN 中继', 'screenTransport.sfu': 'SFU 中转', 'screenTransport.mixed': '混合模式', 'screenTransport.negotiating': '正在建立连接', 'screenTransport.waiting': '等待观看者', 'stats.heading': 'WebRTC 统计', 'stats.requestedCodec': '请求编码', 'stats.collecting': '正在收集统计…', 'stats.sender': '发送端', 'stats.receiver': '接收端', 'stats.codec': '协商编码', 'stats.resolution': '分辨率', 'stats.fps': '帧率', 'stats.bitrate': '码率', 'stats.packetLoss': '丢包数', 'stats.rtt': '往返延迟', 'stats.droppedFrames': '丢帧数', 'stats.freezes': '卡顿次数', 'stats.encodeTime': '平均编码耗时', 'stats.jitter': '抖动', 'stats.jitterBuffer': '平均抖动缓冲', 'stats.bandwidth': '可用上行带宽', 'stats.limitation': '质量受限原因', 'controls.share': '共享屏幕', 'controls.stopShare': '停止共享屏幕',
  'controls.shareShort': '共享屏幕', 'controls.stopShareShort': '停止共享', 'controls.shareGrantRequired': '开始共享前需要主持人授权。', 'controls.leave': '离开会议', 'controls.leaving': '正在离开…',
  'participants.heading': ({ count }) => `参会者（${count}）`, 'participants.label': '参会者', 'participants.you': '你', 'participants.youLabel': '你',
  'participants.microphoneOn': '麦克风已开启', 'participants.microphoneMuted': '麦克风已静音', 'participants.muted': '已静音', 'participants.itemLabel': ({ name, you, microphone }) => `${name}${you ? '，你' : ''}，${microphone}`,
  'host.heading': '主持人控制', 'host.listLabel': '主持人参会者控制', 'host.failed': '主持人操作未能完成。', 'host.revoke': ({ name }) => `撤销 ${name} 的屏幕共享`,
  'host.grant': ({ name }) => `允许 ${name} 共享屏幕`, 'host.kick': ({ name }) => `移出 ${name}`, 'host.end': '结束会议', 'host.ending': '正在结束会议…', 'host.confirmEnd': '要为所有人结束会议吗？',
  'screen.stage': '共享屏幕区域', 'screen.empty': '当前没有人共享屏幕。', 'screen.participant': '参会者', 'screen.videoLabel': ({ name }) => `${name} 的共享屏幕`, 'screen.fullscreen': '全屏观看共享屏幕', 'screen.fullscreenAction': '全屏',
  'screen.noAudio': '未共享电脑音频。在 Chrome 或 Edge 中，请选择浏览器标签页并启用“共享标签页音频”，或选择整个屏幕并在选择器中启用系统音频。',
  'screen.videoOnly': '由于浏览器无法避免会议回音，当前只共享画面，不共享电脑音频。', 'screen.echoRisk': '浏览器无法从系统音频中隔离会议声音，你已选择承担回音风险并继续。',
  'screen.chooseTab': '已取消屏幕共享。请选择浏览器标签页并启用“共享标签页音频”，以隔离内容音频。',
  'audioWarning.heading': '系统音频回音保护', 'audioWarning.description': ({ surface }) => `浏览器无法确认会从所捕获的${surface}音频中移除会议声音，请选择继续方式。`,
  'audioWarning.videoOnly': '仅共享画面', 'audioWarning.continue': '继续共享系统音频', 'audioWarning.cancel': '取消并选择浏览器标签页'
};

const dictionaries: Record<Locale, Record<MessageKey, Message>> = { en, 'zh-CN': zhCN };
const storageKey = 'babagan.locale';

export function resolveInitialLocale(saved: string | null | undefined, languages: readonly string[]): Locale {
  if (saved === 'en' || saved === 'zh-CN') return saved;
  return languages.some((language) => language.toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en';
}

function translate(locale: Locale, key: MessageKey, params: Params = {}): string {
  const value = dictionaries[locale][key];
  return typeof value === 'function' ? value(params) : value;
}

export type Translate = (key: MessageKey, params?: Params) => string;
interface I18nContextValue { locale: Locale; setLocale: (locale: Locale) => void; t: Translate; }
const defaultValue: I18nContextValue = { locale: 'en', setLocale: () => undefined, t: (key, params) => translate('en', key, params) };
const I18nContext = createContext<I18nContextValue>(defaultValue);

export function LanguageProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (initialLocale) return initialLocale;
    let saved: string | null = null;
    try { saved = window.localStorage.getItem(storageKey); } catch { /* storage can be unavailable */ }
    return resolveInitialLocale(saved, navigator.languages?.length ? navigator.languages : [navigator.language]);
  });
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const setLocale = (next: Locale) => {
    setLocaleState(next);
    try { window.localStorage.setItem(storageKey, next); } catch { /* keep the in-session selection */ }
  };
  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t: (key, params) => translate(locale, key, params) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue { return useContext(I18nContext); }

const apiErrorKeys = new Set([
  'MEETING_NOT_FOUND', 'MEETING_EXPIRED', 'MEETING_FULL', 'INVALID_MEETING_PASSWORD', 'ADMIN_AUTH_FAILED',
  'SHARE_ALREADY_ACTIVE', 'SHARE_NOT_AUTHORIZED', 'UNSUPPORTED_CLIENT', 'RATE_LIMITED', 'MEDIA_SERVICE_UNAVAILABLE'
]);

export function apiErrorText(reason: unknown, t: Translate, fallback: MessageKey): string {
  const code = (reason as { details?: { error?: { code?: string } } } | undefined)?.details?.error?.code;
  return code && apiErrorKeys.has(code) ? t(`error.${code}` as MessageKey) : t(fallback);
}
