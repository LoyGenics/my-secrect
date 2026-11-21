import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../popup/popup.css';
import Options from './Options';
import { normalizeLocale } from '../../../../packages/i18n/src/index';
import { I18nProvider } from '../../../../packages/i18n/src/react';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider initialLocale={normalizeLocale(chrome.i18n.getUILanguage())}>
      <Options />
    </I18nProvider>
  </StrictMode>,
);
