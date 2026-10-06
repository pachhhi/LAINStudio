import { initLanguageSelector } from './language-selector.js';

const root = document.querySelector('#legal-content');
const page = document.body.dataset.legalPage;
const content = {
  privacy: {
    en: ['Privacy Policy', [['Information collected', 'LAIN collects only the information needed to create and manage an order or answer a direct enquiry.'], ['Use of information', 'Order and contact information is used only to provide the requested service and support.'], ['Contact', 'Questions about personal information can be sent through the contact channels published on this site.']]],
    es: ['Política de privacidad', [['Información recopilada', 'LAIN recopila únicamente la información necesaria para crear y gestionar una orden o responder una consulta directa.'], ['Uso de la información', 'Los datos de orden y contacto se utilizan sólo para prestar el servicio solicitado y brindar soporte.'], ['Contacto', 'Las consultas sobre datos personales pueden enviarse mediante los canales publicados en este sitio.']]]
  },
  terms: {
    en: ['Terms', [['Scope', 'These terms apply to purchases and services offered directly by LAIN Studio.'], ['Product information', 'Availability, price and product details shown at the time an order is created form the basis of that order.'], ['Contact', 'Questions about an order should include its public order ID.']]],
    es: ['Términos', [['Alcance', 'Estos términos se aplican a compras y servicios ofrecidos directamente por LAIN Studio.'], ['Información de producto', 'La disponibilidad, el precio y los detalles mostrados al crear una orden constituyen la base de esa orden.'], ['Contacto', 'Las consultas sobre una orden deben incluir su identificador público.']]]
  }
};

function render(language) {
  const [title, sections] = content[page][language];
  document.title = `${title} — LAIN STUDIO`;
  root.innerHTML = `<span>LAIN / INFORMATION</span><h1>${title}</h1>${sections.map(([heading, copy]) => `<section><h2>${heading}</h2><p>${copy}</p></section>`).join('')}<p class="legal-review">${language === 'es' ? 'BORRADOR — Requiere revisión legal y datos comerciales definitivos antes de producción.' : 'DRAFT — Requires legal review and final commercial details before production.'}</p>`;
}

render(initLanguageSelector(render));
