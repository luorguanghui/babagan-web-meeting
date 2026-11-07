import { useState } from 'react';
import { useI18n } from '../i18n/i18n.js';

export function MeetingBrandNote() {
  const { t } = useI18n();
  const [artAvailable, setArtAvailable] = useState(true);
  return <div className="meeting-brand-note">
    {artAvailable && <img className="meeting-brand-note-art" src="/theme/sigrika-hero.png" alt="" loading="lazy" onError={() => setArtAvailable(false)} />}
    <p className="meeting-brand-note-copy">{t('room.brandNote')}</p>
  </div>;
}
