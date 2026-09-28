import { getT } from '../lib/i18n/server.js'
import { AUTHOR_SITE_LABEL, AUTHOR_SITE_URL, F451_REPO_URL } from '../lib/attribution'

/**
 * "Based on f451 by www.rotecodefraktion.de" — the notice the f451 License
 * requires in the user interface of every installation that others use.
 * "f451" links to the repository, the site name to the author's website.
 * Rendered in the space sidebar, the settings sidebar and on the sign-in
 * page, so it is visible wherever people work.
 */
export async function Attribution() {
  const { t } = await getT()
  return (
    <p className="attribution">
      {t('shell.attribution.before')}
      <a href={F451_REPO_URL} target="_blank" rel="noopener noreferrer">
        f451
      </a>
      {t('shell.attribution.between')}
      <a href={AUTHOR_SITE_URL} target="_blank" rel="noopener noreferrer">
        {AUTHOR_SITE_LABEL}
      </a>
    </p>
  )
}
