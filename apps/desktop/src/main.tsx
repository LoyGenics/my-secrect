import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Build-time default account server (see apps/desktop/.env.example). */}
    <App defaultApiBaseUrl={import.meta.env.VITE_MY_SECRET_API_BASE_URL ?? ''} />
  </React.StrictMode>,
);
