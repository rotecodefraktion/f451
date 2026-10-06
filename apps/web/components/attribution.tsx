import { getT } from '../lib/i18n/server.js'
import { AUTHOR_SITE_LABEL, AUTHOR_SITE_URL, F451_REPO_URL } from '../lib/attribution'

/**
 * "Based on f451 1.2.7 by www.rotecodefraktion.de" — the notice the f451 License
 * requires in the user interface of every installation that others use.
 * "f451" links to the repository, the site name to the author's website.
 * Rendered in the space sidebar, the settings sidebar and on the sign-in
 * page, so it is visible wherever people work.
 *
 * Operators add their legal notice and privacy policy with F451_IMPRINT_URL /
 * F451_PRIVACY_URL (runtime env). Where the shell renders, they are icon
 * buttons next to the light/dark toggle (`LegalLinks`); only the sign-in page,
 * which has no top bar, passes `legal` to show them as text links right below.
 */
export async function Attribution({ legal: showLegal = false }: { legal?: boolean } = {}) {
  const { t } = await getT()
  // Build argument of the web image (apps/web/Dockerfile); "dev" marks an
  // unreleased build and is shown as well, so operators can tell.
  const version = process.env.F451_VERSION || 'dev'
  const legal = [
    { href: process.env.F451_IMPRINT_URL, label: t('shell.attribution.imprint') },
    { href: process.env.F451_PRIVACY_URL, label: t('shell.attribution.privacy') },
  ].filter((l): l is { href: string; label: string } => Boolean(l.href))
  return (
    <>
    <p className="attribution">
      {t('shell.attribution.before')}
      <a href={F451_REPO_URL} target="_blank" rel="noopener noreferrer">
        f451
      </a>{' '}
      <span className="attribution-version">{version}</span>
      {t('shell.attribution.between')}
      <a href={AUTHOR_SITE_URL} target="_blank" rel="noopener noreferrer">
        {AUTHOR_SITE_LABEL}
      </a>
    </p>
    {showLegal && legal.length > 0 ? (
      <p className="attribution legal">
        {legal.map((l, i) => (
          <span key={l.href}>
            {i > 0 ? ' · ' : null}
            <a href={l.href} target="_blank" rel="noopener noreferrer">
              {l.label}
            </a>
          </span>
        ))}
      </p>
    ) : null}
    </>
  )
}
