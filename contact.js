import { resolveLanguage, translate } from './i18n.js';
import { siteContact } from './site-config.js';

const contact = document.querySelector('#contact');

function contactValue(label, url, language) {
  return url ? `<a href="${url}"${url.startsWith('http') ? ' rel="noopener noreferrer"' : ''}>${label}</a>` : `<span class="contact__pending">${translate(language, 'unavailableContact')}</span>`;
}

function renderContact(language = resolveLanguage()) {
  if (!contact) return;
  contact.innerHTML = `
    <div class="section-header">
      <div>
        <span class="section-header__eyebrow">${translate(language, 'contactEyebrow')}</span>
        <h2 id="contact-title" class="section-header__title">${translate(language, 'contactTitle')}</h2>
        <p class="section-header__description"><small class="section-header__metadata">${translate(language, 'contactAvailability')}</small></p>
      </div>
    </div>
    <dl class="contact__methods">
      <div><dt class="section-header__metadata">${translate(language, 'email')}</dt><dd>${contactValue(siteContact.email, siteContact.email ? `mailto:${siteContact.email}` : null, language)}</dd></div>
      <div><dt class="section-header__metadata">${translate(language, 'instagram')}</dt><dd>${contactValue(siteContact.instagramHandle, siteContact.instagramUrl, language)}</dd></div>
      <div><dt class="section-header__metadata">${translate(language, 'whatsapp')}</dt><dd>${contactValue(siteContact.whatsappLabel, siteContact.whatsappUrl, language)}</dd></div>
      <div><dt class="section-header__metadata">${translate(language, 'location')}</dt><dd>BUENOS AIRES / ARGENTINA</dd></div>
    </dl>
    ${Object.values(siteContact).some(Boolean) ? '' : `<p class="contact__notice section-header__metadata">${translate(language, 'contactPending')}</p>`}
  `;
}

renderContact();
window.addEventListener('lain:languagechange', event => renderContact(event.detail.language));
