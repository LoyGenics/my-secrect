import { Faq, Section } from '../components/Chrome';
import { art } from '../assets';
import { copyFor, earlyAccessHref, fill, slug, type Lang } from '../lib';
import { site } from '../site.config';
import type { LegalSection } from '../content/en';

function DocBody({ sections, lang }: { sections: LegalSection[]; lang: Lang }) {
  return (
    <div className="doc">
      <nav className="doc__toc" aria-label="On this page">
        <ol>{sections.map((s) => <li key={s.h}><a href={`#${slug(s.h)}`}>{s.h}</a></li>)}</ol>
      </nav>
      <div className="doc__body">
        {sections.map((s) => (
          <section key={s.h} id={slug(s.h)} className="doc__sec">
            <h2 className="h3">{s.h}</h2>
            {s.p?.map((t) => <p key={t}>{fill(t, lang)}</p>)}
            {s.ul && <ul className="ticks ticks--roomy">{s.ul.map((t) => <li key={t}>{fill(t, lang)}</li>)}</ul>}
          </section>
        ))}
      </div>
    </div>
  );
}

export function Legal({ lang, kind }: { lang: Lang; kind: 'privacy' | 'terms' }) {
  const c = copyFor(lang);
  const d = c[kind];
  return (
    <>
      <Section className="pagehead">
        <h1 className="h1">{d.h1}</h1>
        <p className="lead lead--small">{c.common.updatedOn}: <time dateTime={site.updated}>{site.updated}</time></p>
      </Section>
      <Section><DocBody sections={d.sections} lang={lang} /></Section>
    </>
  );
}

export function Security({ lang }: { lang: Lang }) {
  const c = copyFor(lang);
  const d = c.security;
  return (
    <>
      <Section className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1 className="h1">{d.h1}</h1>
            <p className="lead">{d.sub}</p>
          </div>
          <img className="pagehead__art float" src={art.locked} alt="" width={220} height={220} />
        </div>
      </Section>
      <Section><DocBody sections={d.sections} lang={lang} /></Section>
    </>
  );
}

export function Support({ lang }: { lang: Lang }) {
  const c = copyFor(lang);
  const d = c.support;
  const mail = site.placeholders.SUPPORT_EMAIL;
  return (
    <>
      <Section className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1 className="h1">{d.h1}</h1>
            <p className="lead">{d.sub}</p>
          </div>
          <img className="pagehead__art float" src={art.done} alt="" width={220} height={220} />
        </div>
      </Section>
      <Section>
        <div className="contact">
          <h2 className="h3">{d.contactH}</h2>
          <p>{fill(d.contact, lang)}</p>
          {mail && <a className="btn" href={earlyAccessHref(lang).replace(/subject=.*/, 'subject=Support')}>{mail}</a>}
        </div>
      </Section>
      <Section>
        <h2 className="h2">{d.faqH}</h2>
        <Faq items={d.faq} lang={lang} />
      </Section>
    </>
  );
}
