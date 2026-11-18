import { Faq, Section, useReveal } from '../components/Chrome';
import { asOf, competitors, matrix, matrixColumns } from '../site.config';
import { copyFor, earlyAccessHref, fill, type Lang } from '../lib';
import { competitorLogos } from '../assets';
import { BlackFridayLink } from './BlackFriday';

function CompetitorLogo({ name }: { name: keyof typeof competitorLogos }) {
  return <img className="comparison-logo" src={competitorLogos[name]} alt={name} width={144} height={40} />;
}

/** A tick, a cross, "partly" or "not stated". The word is always in the DOM for screen readers. */
function Mark({ v, label }: { v: 'yes' | 'no' | 'partial' | 'na'; label: string }) {
  if (v === 'na') return <span className="mark mark--na">{label}</span>;
  if (v === 'partial') return <span className="mark mark--partial">{label}</span>;
  return (
    <span className={`mark mark--${v}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        {v === 'yes' ? <path d="M6.5 12.5l3.6 3.6 7.4-8" /> : <path d="M8 8l8 8M16 8l-8 8" />}
      </svg>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

export default function Pricing({ lang }: { lang: Lang }) {
  const c = copyFor(lang);
  const p = c.pricing;
  const ref = useReveal();
  return (
    <div ref={ref}>
      <Section className="pagehead">
        <h1 className="h1">{p.h1}</h1>
        <p className="lead">{p.sub}</p>
        <BlackFridayLink lang={lang} />
        <p className="after"><a className="textlink" href="#matrix">{p.matrix.jump}</a></p>
      </Section>

      <Section id="plans">
        <div className="plans">
          {p.plans.map((plan) => (
            <article key={plan.id} className={`plan${plan.featured ? ' plan--featured' : ''}${plan.id === 'family' ? ' plan--family' : ''}`}>
              <h2 className="h3">{plan.name}</h2>
              <p className="plan__blurb">{plan.blurb}</p>
              <p className="plan__price"><span className="figure">{plan.price}</span> <span className="plan__unit">{plan.unit}</span></p>
              <p className="plan__alt">{plan.alt ?? ' '}</p>
              <ul className="ticks">{plan.features.map((f) => <li key={f}>{f}</li>)}</ul>
              <a className={`btn${plan.featured ? '' : ' btn--ghost'}`} href={earlyAccessHref(lang)}>{p.cta}</a>
            </article>
          ))}
        </div>
      </Section>

      <Section id="compare" className="reveal">
        <h2 className="h2">{p.compare.h2}</h2>
        <p className="lead lead--small">{fill(p.compare.intro, lang)}</p>
        <div className="tablewrap" tabIndex={0} role="region" aria-label={p.compare.h2}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{p.compare.cols.product}</th>
                <th scope="col">{p.compare.cols.plan}</th>
                <th scope="col" className="num">{p.compare.cols.year}</th>
                <th scope="col">{p.compare.cols.free}</th>
                <th scope="col">{p.compare.cols.lifetime}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="table__ours">
                <th scope="row">{p.compare.ours.name}</th>
                <td>{p.compare.ours.plan}</td>
                <td className="num">{p.compare.ours.year}</td>
                <td>{p.compare.ours.free}</td>
                <td>{p.compare.ours.lifetime}</td>
              </tr>
              {competitors.map((r) => (
                <tr key={r.name}>
                  <th scope="row"><CompetitorLogo name={r.name} /></th>
                  <td>{r.plan}<span className="table__sub">{r.yearlyNote[lang]}</span></td>
                  <td className="num">{lang === 'vi' ? r.yearlyUsd.replace('.', ',') : r.yearlyUsd}</td>
                  <td>{r.free[lang]}</td>
                  <td>{r.lifetime[lang]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine">{asOf[lang]}</p>
      </Section>

      <Section id="matrix" className="reveal">
        <h2 className="h2" id="matrix-title">{p.matrix.h2}</h2>
        <p className="lead lead--small">{fill(p.matrix.intro, lang)}</p>
        <ul className="matrix__legend" aria-label={p.matrix.key}>
          {(['yes', 'no', 'partial', 'na'] as const).map((v) => (
            <li key={v}><Mark v={v} label={p.matrix.legend[v]} />{(v === 'yes' || v === 'no') && <span>{p.matrix.legend[v]}</span>}</li>
          ))}
        </ul>
        <p id="matrix-scroll-hint" className="matrix__hint">{p.matrix.scrollHint}</p>
        <div className="tablewrap matrix__wrap" tabIndex={0} role="region" aria-labelledby="matrix-title" aria-describedby="matrix-scroll-hint">
          <table className="table matrix">
            <caption className="visually-hidden">{p.matrix.h2}</caption>
            <colgroup><col className="matrix__feature" />{matrixColumns.map((col) => <col key={col} />)}</colgroup>
            <thead>
              <tr>
                <th scope="col">{p.matrix.featureCol}</th>
                {matrixColumns.map((col) => {
                  return (
                    <th key={col} scope="col" className={col === 'ours' ? 'matrix__ours' : undefined}>
                      <span className="matrix__brand">{col === 'ours' ? 'My Secret' : <CompetitorLogo name={col} />}</span>
                      {col === 'ours' && <span className="matrix__status">{p.matrix.oursStatus}</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {matrix.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{p.matrix.features[row.id]}</th>
                  {row.cells.map((cell, i) => (
                    <td key={matrixColumns[i]} className={i === 0 ? 'matrix__ours' : undefined}>
                      <Mark v={cell.v} label={p.matrix.legend[cell.v]} />
                      {cell[lang] ? <span className="matrix__note">{cell[lang]}</span> : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine">{p.matrix.footnote}</p>
      </Section>

      <Section className="reveal">
        <h2 className="h2">{p.faq.h2}</h2>
        <Faq items={p.faq.items} lang={lang} />
      </Section>
    </div>
  );
}
