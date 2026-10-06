import { localizeDocument, resolveLanguage, setLanguage } from './i18n.js';

export function initLanguageSelector(onChange) {
  let language = setLanguage(resolveLanguage());
  const buttons = document.querySelectorAll('[data-language]');

  function updateButtons() {
    buttons.forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.language === language));
    });
    localizeDocument(language);
  }

  updateButtons();

  buttons.forEach(button => {
    button.addEventListener('click', () => {
      language = setLanguage(button.dataset.language);
      updateButtons();
      onChange?.(language);
      window.dispatchEvent(new CustomEvent('lain:languagechange', { detail: { language } }));
    });
  });

  return language;
}
