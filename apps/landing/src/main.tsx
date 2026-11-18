import '@fontsource-variable/bricolage-grotesque/index.css';
import '@fontsource/be-vietnam-pro/400.css';
import '@fontsource/be-vietnam-pro/500.css';
import '@fontsource/be-vietnam-pro/600.css';
import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import App from './App';
import { parsePath } from './routes';
import './styles/site.css';

document.documentElement.classList.add('js');
const route = parsePath(location.pathname);
const root = document.getElementById('root')!;
const app = <StrictMode><App route={route} /></StrictMode>;
if (root.hasChildNodes()) {
  hydrateRoot(root, app);
} else {
  document.documentElement.lang = route?.lang ?? 'en';
  createRoot(root).render(app);
}
