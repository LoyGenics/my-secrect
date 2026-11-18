import { Footer, Nav } from './components/Chrome';
import Home from './pages/Home';
import Pricing from './pages/Pricing';
import BlackFriday from './pages/BlackFriday';
import { Legal, Security, Support } from './pages/Doc';
import { copyFor } from './lib';
import type { Route } from './routes';

export default function App({ route }: { route: Route | null }) {
  const { lang, page } = route ?? { lang: 'en', page: 'home' };
  const c = copyFor(lang);
  return (
    <>
      <a className="skip" href="#main">{c.nav.skip}</a>
      <Nav lang={lang} page={page} />
      <main id="main" tabIndex={-1}>
        {!route && (
          <section className="section pagehead">
            <div className="container">
              <h1 className="h1">Page not found</h1>
              <p className="lead"><a className="textlink" href="/">Go to My Secret</a></p>
            </div>
          </section>
        )}
        {route && page === 'home' && <Home lang={lang} />}
        {page === 'black-friday' && <BlackFriday lang={lang} />}
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
