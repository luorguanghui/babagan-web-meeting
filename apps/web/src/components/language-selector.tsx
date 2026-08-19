import { useI18n } from '../i18n/i18n.js';

export function LanguageSelector() {
  const { locale, setLocale, t } = useI18n();
  return <div className="language-bar"><label className="language-selector">
    <span>{t('language.label')}</span>
    <select aria-label={t('language.label')} value={locale} onChange={(event) => setLocale(event.target.value as 'en' | 'zh-CN')}>
      <option value="zh-CN">{t('language.zh-CN')}</option>
      <option value="en">{t('language.en')}</option>
    </select>
  </label></div>;
}
