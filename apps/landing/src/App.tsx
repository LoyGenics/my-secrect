import { useEffect } from 'react';
import { Footer, Nav } from './components/Chrome';
import Home from './pages/Home';
import Pricing from './pages/Pricing';
import { Legal, Security, Support } from './pages/Doc';
import { copyFor, useRoute } from './lib';

export default function App() {
  const { lang, page } = useRoute();
  const c = copyFor(lang);
  const meta = c.meta[page];
  useEffect(() => {
    document.documentElement.lang = c.htmlLang;
    document.title = meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', meta.description);
  }, [c.htmlLang, meta.title, meta.description]);
  // Jump to #section links (the router never reloads the page).
  useEffect(() => {
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }, [page, lang]);
  return (
    <>
      <a className="skip" href="#main">{c.nav.skip}</a>
      <Nav lang={lang} page={page} />
      <main id="main" tabIndex={-1}>
        {page === 'home' && <Home lang={lang} />}
        {page === 'pricing' && <Pricing lang={lang} />}
        {page === 'security' && <Security lang={lang} />}
        {page === 'privacy' && <Legal lang={lang} kind="privacy" />}
        {page === 'terms' && <Legal lang={lang} kind="terms" />}
        {page === 'support' && <Support lang={lang} />}
      </main>
      <Footer lang={lang} />
    </>
  );
}
