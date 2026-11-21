import { ChevronDown, Globe2 } from 'lucide-react';

import { useI18n } from '../i18n/i18n.js';

export function LanguageSelector({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  return <div className="language-bar"><label className={compact ? 'language-selector language-selector-compact' : 'language-selector'}>
    {compact ? <Globe2 size={18} aria-hidden="true" /> : <span>{t('language.label')}</span>}
    <select aria-label={t('language.label')} value={locale} onChange={(event) => setLocale(event.target.value as 'en' | 'zh-CN')}>
      <option value="zh-CN">{t('language.zh-CN')}</option>
      <option value="en">{t('language.en')}</option>
    </select>
    {compact && <ChevronDown size={14} aria-hidden="true" />}
  </label></div>;
}
