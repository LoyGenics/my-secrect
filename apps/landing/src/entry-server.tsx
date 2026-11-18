import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import App from './App';
import { copyFor } from './lib';
import { href, LANGS, type Lang, type Page, type Route } from './routes';
import { site } from './site.config';

const socialImage = `${site.origin}/my-secret.png`;

export function pageUrl(lang: Lang, page: Page) {
  return site.origin + href(lang, page);
}

export function isIndexable(page: Page) {
  // Legal pages still contain unapproved placeholders and support has no published email.
  return page !== 'privacy' && page !== 'terms' && (page !== 'support' || !!site.placeholders.SUPPORT_EMAIL);
}

function Head({ route }: { route: Route | null }) {
  if (!route) {
    return <><title>Page not found | My Secret</title><meta name="robots" content="noindex, follow" /></>;
  }

  const { lang, page } = route;
  const c = copyFor(lang);
  const { title, description } = c.meta[page];
  const canonical = pageUrl(lang, page);
  const indexable = isIndexable(page);
  const website = { '@type': 'WebSite', '@id': `${site.origin}/#website`, url: `${site.origin}/`, name: site.name, inLanguage: LANGS };
  const application = {
    '@type': 'SoftwareApplication',
    '@id': `${site.origin}/#app`,
    name: site.name,
    url: `${site.origin}/`,
    description,
    applicationCategory: 'SecurityApplication',
    inLanguage: lang,
    image: socialImage,
    featureList: [...c.home.principles, ...c.home.keeps.items],
  };
  const webpage = {
    '@type': 'WebPage',
    '@id': `${canonical}#page`,
    url: canonical,
    name: title,
    description,
    inLanguage: lang,
    isPartOf: { '@id': website['@id'] },
    about: { '@id': application['@id'] },
  };
  const schema = {
    '@context': 'https://schema.org',
    '@graph': page === 'home' ? [website, application, webpage] : [webpage],
  };
  const jsonLd = JSON.stringify(schema).replace(/</g, '\\u003c');

  return (
    <>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta name="robots" content={indexable ? 'index, follow, max-image-preview:large' : 'noindex, follow'} />
      <link rel="canonical" href={canonical} />
      {indexable && LANGS.map((locale) => <link key={locale} rel="alternate" hrefLang={locale} href={pageUrl(locale, page)} />)}
      {indexable && <link rel="alternate" hrefLang="x-default" href={pageUrl('en', page)} />}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={site.name} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonical} />
      <meta property="og:locale" content={lang === 'vi' ? 'vi_VN' : 'en_US'} />
      <meta property="og:locale:alternate" content={lang === 'vi' ? 'en_US' : 'vi_VN'} />
      <meta property="og:image" content={socialImage} />
      <meta property="og:image:width" content="512" />
      <meta property="og:image:height" content="512" />
      <meta property="og:image:alt" content={site.name} />
      <meta name="twitter:card" content="summary" />
      {indexable && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />}
    </>
  );
}

export function render(route: Route | null) {
  return {
    head: renderToStaticMarkup(<Head route={route} />),
    body: renderToString(<App route={route} />),
  };
}
