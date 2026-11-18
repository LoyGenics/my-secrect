import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ghostMark } from '../assets';
import { LANGS, Link, copyFor, fill, href, type Lang, type Page } from '../lib';
import { site } from '../site.config';

export function Wordmark({ lang }: { lang: Lang }) {
  const c = copyFor(lang);
  return (
    <Link to={href(lang, 'home')} className="wordmark" aria-label={c.nav.home}>
      <img className="wordmark__mark" src={ghostMark} alt="" width={32} height={32} />
      <span>My Secret</span>
    </Link>
  );
}

function LangSwitch({ lang, page }: { lang: Lang; page: Page }) {
  const c = copyFor(lang);
  return (
    <div className="langs" role="group" aria-label={c.nav.language}>
      {LANGS.map((l) => (
        <Link key={l} to={href(l, page)} className="langs__item" aria-current={l === lang ? 'true' : undefined} lang={l} hrefLang={l}>
          {l.toUpperCase()}
        </Link>
      ))}
    </div>
  );
}

export function Nav({ lang, page }: { lang: Lang; page: Page }) {
  const c = copyFor(lang);
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [lang, page]);
  const links: Array<[Page, string]> = [['pricing', c.nav.pricing], ['security', c.nav.security], ['support', c.nav.support]];
  return (
    <header className="nav">
      <div className="container nav__row">
        <Wordmark lang={lang} />
        <nav className="nav__links" aria-label="Primary" data-open={open}>
          {links.map(([p, label]) => (
            <Link key={p} to={href(lang, p)} className="nav__link" aria-current={page === p ? 'page' : undefined}>{label}</Link>
          ))}
        </nav>
        <div className="nav__end">
          <LangSwitch lang={lang} page={page} />
          <a className="btn btn--sm nav__cta" href={site.appUrl}>{c.nav.cta}</a>
          <button type="button" className="nav__burger" aria-expanded={open} aria-controls="primary-nav" aria-label={open ? c.nav.close : c.nav.menu} onClick={() => setOpen((v) => !v)}>
            <span aria-hidden="true" />
          </button>
        </div>
      </div>
      <nav id="primary-nav" className="nav__sheet" aria-label="Primary" hidden={!open}>
        <div className="container">
          {links.map(([p, label]) => (<Link key={p} to={href(lang, p)} className="nav__sheet-link" aria-current={page === p ? 'page' : undefined}>{label}</Link>))}
          <a className="btn" href={site.appUrl}>{c.nav.cta}</a>
        </div>
      </nav>
    </header>
  );
}

export function Footer({ lang }: { lang: Lang }) {
  const c = copyFor(lang);
  const f = c.footer;
  return (
    <footer className="footer">
      <div className="container footer__grid">
        <div className="footer__brand">
          <Wordmark lang={lang} />
          <p>{f.tagline}</p>
        </div>
        <nav aria-label={f.product} className="footer__col">
          <h2 className="footer__h">{f.product}</h2>
          <Link to={href(lang, 'pricing')}>{c.nav.pricing}</Link>
          <Link to={href(lang, 'security')}>{c.nav.security}</Link>
          <Link to={href(lang, 'black-friday')}>{c.blackFriday.link}</Link>
        </nav>
        <nav aria-label={f.company} className="footer__col">
          <h2 className="footer__h">{f.company}</h2>
          <Link to={href(lang, 'support')}>{c.nav.support}</Link>
        </nav>
        <nav aria-label={f.legal} className="footer__col">
          <h2 className="footer__h">{f.legal}</h2>
          <Link to={href(lang, 'privacy')}>{f.privacy}</Link>
          <Link to={href(lang, 'terms')}>{f.terms}</Link>
        </nav>
      </div>
      <div className="container footer__base">
        <p>{fill(f.rights, lang)}</p>
        <p>{f.early}</p>
      </div>
    </footer>
  );
}

/** Reveal once on scroll. Content is visible without scripting or motion (CSS only hides under html.js). */
export function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('.reveal'));
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      nodes.forEach((n) => n.classList.add('in'));
      return undefined;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    nodes.forEach((n) => io.observe(n));
    // A jump to a #section link can land past the observer's first callback: reveal whatever is already on screen.
    const showVisible = () => nodes.forEach((n) => {
      const r = n.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) n.classList.add('in');
    });
    const t = window.setTimeout(showVisible, 120);
    window.addEventListener('scroll', showVisible, { passive: true, once: true });
    return () => { io.disconnect(); window.clearTimeout(t); window.removeEventListener('scroll', showVisible); };
  });
  return ref;
}

export function Faq({ items, lang }: { items: ReadonlyArray<{ q: string; a: string }>; lang: Lang }) {
  return (
    <div className="faq">
      {items.map((it) => (
        <details key={it.q} className="faq__item">
          <summary>{it.q}</summary>
          <p>{fill(it.a, lang)}</p>
        </details>
      ))}
    </div>
  );
}

export function Section({ id, className = '', children }: { id?: string; className?: string; children: ReactNode }) {
  return <section id={id} className={`section ${className}`}><div className="container">{children}</div></section>;
}
