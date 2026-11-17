import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../popup/popup.css';
import Options from './Options';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
