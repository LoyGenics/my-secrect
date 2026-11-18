import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { Section } from '../components/Chrome';
import { art } from '../assets';
import { copyFor, href, Link, type Lang } from '../lib';
import { site } from '../site.config';

export function BlackFridayLink({ lang }: { lang: Lang }) {
  return (
    <Link className="campaign-link textlink inline-link" to={href(lang, 'black-friday')}>
      {copyFor(lang).blackFriday.link}<ArrowRight size={17} aria-hidden="true" />
    </Link>
  );
}

export default function BlackFriday({ lang }: { lang: Lang }) {
  const c = copyFor(lang).blackFriday;
  return (
    <>
      <Section className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1 className="h1">{c.title}</h1>
            <p className="lead">{c.intro}</p>
            <p className="after">{c.details}</p>
            <div className="actions">
              <a className="btn" href={site.appUrl}>{c.tryApp}<ArrowUpRight size={18} aria-hidden="true" /></a>
            </div>
            <p className="fine">{c.signupNote}</p>
          </div>
          <img className="pagehead__art" src={art.hero} alt="" width={220} height={220} />
        </div>
      </Section>
      <Section className="campaign-details">
        <h2 className="h2">{c.overview}</h2>
        <ul className="ticks ticks--roomy">
          {c.highlights.map((feature) => <li key={feature}>{feature}</li>)}
        </ul>
        <div className="actions">
          <Link className="textlink" to={href(lang, 'pricing')}>{c.pricing}</Link>
          <Link className="textlink" to={href(lang, 'security')}>{c.security}</Link>
        </div>
      </Section>
    </>
  );
}
