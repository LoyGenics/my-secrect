'use client';

import { useRef } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { ArrowRight, ArrowUpRight, Fingerprint, KeyRound, Laptop, LockKeyhole, MonitorSmartphone, ShieldCheck, Smartphone, Globe, Puzzle, UsersRound, Check, Cloud } from 'lucide-react';
import { Faq, Section } from '../components/Chrome';
import VaultScene from '../components/VaultScene';
import VaultExplorer from '../components/VaultExplorer';
import { BlackFridayLink } from './BlackFriday';
import { Link, copyFor, href, type Lang } from '../lib';
import { site } from '../site.config';

export default function Home({ lang }: { lang: Lang }) {
  const c = copyFor(lang);
  const h = c.home;
  const hero = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: hero, offset: ['start start', 'end start'] });
  const sceneY = useTransform(scrollYProgress, [0, 1], [0, 90]);
  const sceneRotate = useTransform(scrollYProgress, [0, 1], [0, 5]);
  const steps = [Fingerprint, LockKeyhole, KeyRound];
  const devices = [Laptop, Globe, Puzzle, Smartphone];
  return (
    <div className="home">
      <section className="hero" ref={hero}>
        <div className="container hero__grid">
          <div className="hero__text">
            <h1>{h.hero.h1.split('\n').map((line, i) => <span key={line} className={i ? 'hero__accent' : undefined}>{i > 0 && ' '}{line}</span>)}</h1>
            <p className="hero__sub">{h.hero.sub}</p>
            <div className="actions">
              <a className="btn btn--lg" href={site.appUrl}>{h.hero.primary}<ArrowUpRight size={19} aria-hidden="true" /></a>
              <Link className="hero__secondary" to={href(lang, 'pricing')}>{h.hero.secondary}<ArrowRight size={18} aria-hidden="true" /></Link>
            </div>
            <BlackFridayLink lang={lang} />
          </div>
          <motion.div className="hero__visual" style={reduced ? undefined : { y: sceneY, rotate: sceneRotate }}>
            <VaultScene copy={h.scene} />
          </motion.div>
        </div>
      </section>

      <div className="container principles">
        {[ShieldCheck, Laptop, KeyRound].map((Icon, i) => <p key={h.principles[i]}><Icon size={19} aria-hidden="true" />{h.principles[i]}</p>)}
      </div>

      <Section id="keeps" className="keeps-section">
        <h2 className="h2">{h.keeps.h2}</h2>
        <p className="lead lead--small">{h.keeps.sub}</p>
        <VaultExplorer items={h.keeps.items} label={h.keeps.h2} note={h.keeps.note} />
      </Section>

      <Section id="server" className="privacy-section">
        <div className="privacy-layout">
          <div className="privacy-copy">
            <h2 className="h2">{h.server.h2}</h2>
            <p className="lead lead--small">{h.server.sub}</p>
            <Link className="textlink inline-link" to={href(lang, 'security')}>{h.server.link}<ArrowUpRight size={17} aria-hidden="true" /></Link>
          </div>
          <div className="privacy-flow">
            <div className="privacy-flow__device">
              <div className="privacy-flow__icon"><MonitorSmartphone size={36} strokeWidth={1.4} aria-hidden="true" /><LockKeyhole size={18} aria-hidden="true" /></div>
              <h3>{h.server.yoursTitle}</h3>
              <ul>{h.server.yours.map(t => <li key={t}><Check size={14} aria-hidden="true" />{t}</li>)}</ul>
            </div>
            <div className="privacy-flow__transfer" aria-hidden="true"><span /><LockKeyhole size={18} /><span /></div>
            <div className="privacy-flow__cloud">
              <Cloud size={36} strokeWidth={1.4} aria-hidden="true" />
              <h3>{h.server.serverTitle}</h3>
              <ul>{h.server.server.map(t => <li key={t}>{t}</li>)}</ul>
            </div>
          </div>
        </div>
      </Section>

      <Section id="signin" className="signin-section">
        <h2 className="h2">{h.signin.h2}</h2>
        <div className="signin-steps">
          {h.signin.items.map((item, i) => { const Icon = steps[i]; return <article key={item.t}><Icon size={30} strokeWidth={1.4} aria-hidden="true" /><h3>{item.t}</h3><p>{item.d}</p></article>; })}
        </div>
        <p className="fine">{h.signin.note}</p>
      </Section>

      <Section id="family" className="family-section">
        <div className="family-layout">
          <div className="family-visual" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map(i => <div className="family-visual__person" key={i}><UsersRound size={32} strokeWidth={1.4} /><span><LockKeyhole size={14} /></span></div>)}
            <div className="family-visual__label"><ShieldCheck size={18} />{h.family.visual}</div>
          </div>
          <div>
            <h2 className="h2">{h.family.h2}</h2>
            <p className="lead lead--small">{h.family.sub}</p>
            <ul className="family-points">{h.family.points.map(point => <li key={point}><Check size={17} aria-hidden="true" />{point}</li>)}</ul>
            <Link className="textlink inline-link" to={`${href(lang, 'pricing')}#plans`}>{h.family.link}<ArrowUpRight size={17} aria-hidden="true" /></Link>
          </div>
        </div>
      </Section>

      <Section id="everywhere" className="devices-section">
        <h2 className="h2">{h.everywhere.h2}</h2>
        <dl className="device-list">
          {h.everywhere.items.map((item, i) => { const Icon = devices[i]; return <div key={item.t}><Icon size={26} strokeWidth={1.4} aria-hidden="true" /><dt>{item.t}</dt><dd>{item.d}</dd></div>; })}
        </dl>
        <p className="fine">{h.everywhere.note}</p>
      </Section>

      <Section id="price" className="price-section">
        <div className="price-invitation">
          <h2>{h.price.h2}</h2>
          <p>{h.price.line}</p>
          <Link className="btn btn--lg" to={href(lang, 'pricing')}>{h.price.link}<ArrowUpRight size={19} aria-hidden="true" /></Link>
        </div>
      </Section>

      <Section id="faq" className="faq-section">
        <h2 className="h2">{h.faq.h2}</h2>
        <Faq items={h.faq.items} lang={lang} />
      </Section>
    </div>
  );
}
