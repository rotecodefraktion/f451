import { getT } from '../lib/i18n/server.js'

/**
 * The operator's legal notice and privacy policy (runtime env F451_IMPRINT_URL /
 * F451_PRIVACY_URL) as icon buttons, rendered next to the light/dark toggle.
 * Renders nothing when neither is set.
 */
export async function LegalLinks() {
  const { t } = await getT()
  const imprint = process.env.F451_IMPRINT_URL
  const privacy = process.env.F451_PRIVACY_URL
  if (!imprint && !privacy) return null
  return (
    <>
      {imprint ? (
        <a
          className="btn quiet icon legal-link"
          href={imprint}
          target="_blank"
          rel="noopener noreferrer"
          title={t('shell.attribution.imprint')}
          aria-label={t('shell.attribution.imprint')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
            <path d="M9 13h6" />
            <path d="M9 17h6" />
          </svg>
        </a>
      ) : null}
      {privacy ? (
        <a
          className="btn quiet icon legal-link"
          href={privacy}
          target="_blank"
          rel="noopener noreferrer"
          title={t('shell.attribution.privacy')}
          aria-label={t('shell.attribution.privacy')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path d="M12 3l8 3v6c0 4.5-3.2 8.3-8 9-4.8-.7-8-4.5-8-9V6z" />
          </svg>
        </a>
      ) : null}
    </>
  )
}
