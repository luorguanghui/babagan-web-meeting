import { ArrowRight, Link2 } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useI18n } from '../i18n/i18n.js';
import { parseClientMeetingInput } from './client-meeting-input.js';
import './meeting-entry-form.css';

const copy = {
  en: {
    label: 'Meeting link or ID', placeholder: 'Paste an invitation or enter its ID', button: 'Join meeting',
    hint: 'Use an invitation from this Babagan site or enter the full meeting ID.',
    error: 'Enter a valid meeting ID or a meeting link from this Babagan site.',
  },
  'zh-CN': {
    label: '会议链接或 ID', placeholder: '粘贴邀请链接或输入 ID', button: '加入会议',
    hint: '使用当前 Babagan 站点的邀请链接，或输入完整会议 ID。',
    error: '请输入有效的会议 ID，或当前 Babagan 站点的会议链接。',
  },
} as const;

export function MeetingEntryForm() {
  const { locale } = useI18n();
  const text = copy[locale];
  const navigate = useNavigate();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = parseClientMeetingInput(value, window.location.origin);
    if (!target) {
      setInvalid(true);
      input.current?.focus();
      return;
    }
    navigate(target.path);
  }

  return <form className="meeting-entry-form" onSubmit={submit} noValidate>
    <label htmlFor={inputId}>{text.label}</label>
    <div className="meeting-entry-row">
      <div className="meeting-entry-input">
        <Link2 size={18} aria-hidden="true" />
        <input ref={input} id={inputId} value={value} onChange={event => { setValue(event.target.value); setInvalid(false); }}
          placeholder={text.placeholder} maxLength={2048} autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="go"
          aria-invalid={invalid || undefined} aria-describedby={`${inputId}-message`} />
      </div>
      <button type="submit">{text.button}<ArrowRight size={18} aria-hidden="true" /></button>
    </div>
    {invalid ? <p id={`${inputId}-message`} className="meeting-entry-error" role="alert">{text.error}</p>
      : <span id={`${inputId}-message`} className="sr-only">{text.hint}</span>}
  </form>;
}
