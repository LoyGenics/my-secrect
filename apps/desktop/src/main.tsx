import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { HOSTED_API_BASE_URL } from '../../../packages/sdk/src/hosted';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* The hosted My Secret cloud; VITE_MY_SECRET_API_BASE_URL is a developer override only. */}
    <App defaultApiBaseUrl={import.meta.env.VITE_MY_SECRET_API_BASE_URL || HOSTED_API_BASE_URL} />
  </React.StrictMode>,
);
