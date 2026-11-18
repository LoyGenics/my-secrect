import '@fontsource-variable/bricolage-grotesque/index.css';
import '@fontsource/be-vietnam-pro/400.css';
import '@fontsource/be-vietnam-pro/500.css';
import '@fontsource/be-vietnam-pro/600.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/site.css';

document.documentElement.classList.add('js');
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
