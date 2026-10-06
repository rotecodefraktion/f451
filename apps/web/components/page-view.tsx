import { placeFootnotes, type Classification } from '@f451/markdown'
import { Breadcrumb } from './breadcrumb'
import { PageBody } from './page-body'
import { ReadingPosition } from './reading-position'
import { StatusBarBottom } from './status-bar-bottom'
import { UnarchiveButton } from './unarchive-button'
import { takeLeadHeading } from '../lib/lead-heading'
import { getT } from '../lib/i18n/server.js'
import { buildBreadcrumb, formatUpdatedAt, sectionSlugs } from '../lib/page-view'
import { placesFootnotes } from '../lib/footnotes-mode'
import { getFrame, getSwitches } from '../lib/resolved-theme'
import { wikiPageEditHref, wikiPageReleaseHref, wikiPageReviewHref, wikiPageVersionsHref } from '../lib/urls'

/** Eine Überschrift der Seite (Shape aus `GET /api/pages/:id`, Feld `headings`). */
export interface PageHeading {
  depth: number
  text: string
  slug: string
}

/** `workflow`-Feld von `GET /api/pages/:id` (Phase 2d Task 2, s.
 *  `apps/api/src/routes/pages.ts#PageWorkflowField`) — `null` für
 *  Nur-Leser/Anonyme/Provider-Fehler (kein Informationsleck über Entwürfe). */
export interface PageWorkflowField {
  state: 'working' | 'review'
  pr: { number: number; url: string } | null
  lock: { user: string; mine: boolean } | null
}

/** Antwort-Shape von `GET /api/pages/:id` (siehe apps/api/src/routes/pages.ts). */
export interface PageData {
  id: string
  space: string
  path: string
  title: string
  html: string
  headings: PageHeading[]
  tags: string[]
  relations: Record<string, string[]>
  frontmatterErrors: string[]
  errorStatus: string | null
  archived: boolean
  updatedAt: string
  brokenLinks: string[]
  workflow: PageWorkflowField | null
  /** Rohe Frontmatter-Metadaten-Werte der Seite (Metadaten-Feature M1, Feld
   *  `PageFrontmatter.metadata` in `@f451/markdown`) — schema-freier
   *  Werte-Record, dessen Form vom space-spezifischen `_meta/schema.yaml`
   *  abhängt. Anzeige (M2) s. `lib/metadata-view.ts` + `components/rail.tsx`. */
  metadata: Record<string, unknown>
  /** Seitenversionierung Etappe 1 (Task 8): `versioning` kommt aus dem
   *  Space-Schema (`_meta/schema.yaml`) und wird von der API IMMER
   *  mitgeliefert — optional hier nur, weil ältere gecachte Antworten
   *  (SWR o. Ä.) das Feld theoretisch noch nicht kennen könnten. */
  versioning?: boolean
  /** Semver der letzten Freigabe (aus dem Frontmatter, systemverwaltet) —
   *  fehlt, wenn die Seite noch nie freigegeben wurde oder der Space
   *  unversioniert ist (s. `versioning`). */
  version?: string
  /** `true`, wenn seit der letzten Freigabe direkt (an der Freigabe vorbei)
   *  committet wurde — Blob-SHA-Vergleich (`pages.lastBlobSha` gegen
   *  `page_versions.blobSha`), s. `apps/api/src/routes/pages.ts#resolveVersionFields`. */
  changedSinceRelease?: boolean
  /** Effective security classification; only present when the space enables
   *  classifications (`classification:` block in `_meta/schema.yaml`). */
  classification?: Classification
  classificationSettings?: { default: Classification; max: Classification }
  /** Newest frozen release (#40). */
  latestRelease?: string
}

/** Chip variant per class — existing `.chip` variants, no new tokens. */
export const CLASSIFICATION_CHIP: Record<Classification, string> = {
  public: 'neutral',
  internal: 'neutral',
  confidential: 'warn',
  'strictly-confidential': 'error',
}

export const CHECK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} aria-hidden="true">
    <path d="m5 13 4 4 10-11" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const ARCHIVE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M3 7h18v3H3zM5 10v9h14v-9M9 13h6" strokeLinejoin="round" />
  </svg>
)

export const WARN_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M12 3 2 20h20L12 3Z" strokeLinejoin="round" />
    <path d="M12 10v4M12 17v.01" strokeLinecap="round" />
  </svg>
)

const EDIT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M4 20h4L18 10l-4-4L4 16z" strokeLinejoin="round" />
    <path d="m13 5 3 3" strokeLinecap="round" />
  </svg>
)

/** `.chip.review` „In Review" — identisch zu `docs/design/mockups/review-diff.html`. */
const CLOCK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** `.notice.draft` — identisch zu `docs/design/mockups/leseansicht.html`. */
const DRAFT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d="M14 3H6v18h12V8z" strokeLinejoin="round" />
    <path d="M14 3v5h5M9 13h6M9 17h4" strokeLinecap="round" />
  </svg>
)

/** `.notice.lock` — identisch zum Editor-Pendant (`lock-banner.tsx#LOCK_ICON`). */
const LOCK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" strokeLinecap="round" />
  </svg>
)

/** Initialen aus dem Anzeigenamen — identisch zu `lock-banner.tsx#initials`
 *  (bewusst dupliziert statt einer neuen geteilten Utility für eine einzige
 *  4-Zeilen-Funktion, s. dortiger Kommentar/Task-4-Self-Review). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase()
}

/**
 * Leseansicht einer Wiki-Seite als EINE Karte (`<main className="main">`,
 * abgenommenes Mockup docs/design/mockups/leseansicht.html): Toolbar mit
 * Breadcrumb + Status-Badge, Subbar mit Aktualisierungsdatum, optionale
 * Warnbanner (Frontmatter-/Parse-Fehler amber, tote Verweise danger) und der
 * gerenderte Artikel-HTML in `.page-body` (via `<PageBody>` — Sicherheits-
 * Kommentar zu `dangerouslySetInnerHTML` und YouTube-Klick-zu-Player s. dort,
 * `components/page-body.tsx`).
 */
export async function PageView({ data }: { data: PageData }) {
  const { t, locale } = await getT()
  const crumbs = buildBreadcrumb(data.space, data.path, data.title)
  // Abschnitte der GANZEN Seite für die Positionsanzeige des Kolumnentitels —
  // Serverdaten, kein DOM-Zähler (s. `lib/page-view.ts#sectionSlugs`).
  const sections = sectionSlugs(data.headings)
  const hasFrontmatterIssue = data.errorStatus !== null || data.frontmatterErrors.length > 0
  const hasBrokenLinks = data.brokenLinks.length > 0
  const workflow = data.workflow
  // `workflow !== null` impliziert bereits einen existierenden Draft-Branch
  // (`getWorkflowState` liefert sonst `null`, s. `apps/api/src/drafts/lifecycle.ts`)
  // — die Draft-Notice ist deshalb an die reine Anwesenheit gekoppelt, nicht an
  // ein zusätzliches Zustandsfeld.
  const hasDraftNotice = workflow !== null
  const hasLockNotice = !!(workflow?.lock && !workflow.lock.mine)
  const isStrictlyConfidential = data.classification === 'strictly-confidential'
  const hasNotices = hasFrontmatterIssue || hasBrokenLinks || hasDraftNotice || isStrictlyConfidential
  // Frame switch `--page-head` (f451#60): `title` puts the frontmatter title
  // as h1 into the frame (`.doc-head` + `.metaline`); `toolbar` keeps the
  // running head, toolbar and subbar of 1.2.5. Only the reading view switches.
  // `--status-bar: bottom` adds the status bar at the foot of `.main`.
  const { pageHead, statusBar } = await getFrame({ hasTree: true })
  const titleMode = pageHead === 'title'
  // Title mode: a leading `# Heading` of the body becomes the title row and
  // leaves the body (never two h1); without one the frontmatter title is used.
  const { headingHtml, rest: leadlessHtml } = titleMode
    ? takeLeadHeading(data.html)
    : { headingHtml: null, rest: data.html }
  // Switch `--marginalia` (f451#63): `margin` moves single-paragraph notes
  // next to their paragraph; `list` keeps the GFM end list as stored.
  const bodyHtml = placesFootnotes(await getSwitches()) ? placeFootnotes(leadlessHtml) : leadlessHtml

  // Workflow status chip — in the head (`.toolbar`/`.doc-head`) and, with the
  // status bar on, again in the status bar.
  const statusChip =
    workflow?.state === 'review' ? (
      <span className="chip review">
        {CLOCK_ICON}
        {t('read.status.review')}
      </span>
    ) : workflow?.state === 'working' ? (
      <span className="chip working">
        {EDIT_ICON}
        {t('read.status.draft')}
      </span>
    ) : data.archived ? (
      <span className="chip archived">
        {ARCHIVE_ICON}
        {t('read.status.archived')}
      </span>
    ) : (
      <span className="chip released">
        {CHECK_ICON}
        {t('read.status.released')}
      </span>
    )

  const updatedItem = (
    <span>
      {t('read.subbar.updated')} <b>{formatUpdatedAt(data.updatedAt, locale)}</b>
    </span>
  )

  // Status chip(s) and actions — carried by `.toolbar` or by `.doc-head`.
  const statusAndActions = (
    <>
      {data.classification ? (
        <span
          className={`chip classification ${CLASSIFICATION_CHIP[data.classification]}`}
          title={t('read.classification.hint')}
        >
          {t(`read.classification.${data.classification}`)}
        </span>
      ) : null}
      {statusChip}
      {/* „Aus Archiv holen" (Feature „Unarchive"): der „Bearbeiten"-Link
          unten ist bei einer archivierten Seite ausgeblendet — ohne diesen
          Button käme niemand mehr in den Editor, um `archived` zu entfernen.
          Only when the archived chip is the one shown (no draft/review). */}
      {workflow === null && data.archived ? <UnarchiveButton pageId={data.id} /> : null}
      {!data.archived ? (
        <a className="btn primary" href={wikiPageEditHref(data.space, data.id)}>
          {EDIT_ICON}
          {t('read.edit')}
        </a>
      ) : null}
    </>
  )

  // Updated / space / version — carried by `.subbar` or by `.metaline`.
  const metaItems = (
    <>
      {updatedItem}
      <span>
        {t('read.subbar.space')} <b>{data.space}</b>
      </span>
      {/* Versionsanzeige (Seitenversionierung Etappe 1, Task 8): nur wenn der
          Space versioniert ist UND eine Version bekannt ist (nie
          freigegeben → `data.version` fehlt trotz `versioning:true`). Der
          "geändert seit"-Hinweis daneben zeigt, dass seit der Freigabe
          direkt (an der Freigabe vorbei) committet wurde. */}
      {data.versioning && data.version ? (
        <>
          {/* Etappe 2: die Nummer führt zur Versionsliste. */}
          <a
            className="subbar-version"
            href={wikiPageVersionsHref(data.space, data.id)}
            title={t('read.subbar.versionsLink')}
          >
            {t('read.subbar.version', { version: data.version })}
          </a>
          {data.latestRelease ? (
            <a className="subbar-version" href={wikiPageReleaseHref(data.space, data.id, data.latestRelease)}>
              {t('read.releases.subbarLink', { version: data.latestRelease })}
            </a>
          ) : null}
          {data.changedSinceRelease ? (
            <span className="subbar-changed" title={t('read.subbar.changedSinceHint')}>
              {t('read.subbar.changedSince', { version: data.version })}
            </span>
          ) : null}
        </>
      ) : null}
    </>
  )

  return (
    <main className="main">
      {titleMode ? (
        <>
          {/* Title row (spec "`--page-head: title` und das h1"): the frame
              renders the body's leading h1 (`lib/lead-heading.ts`) or, without
              one, the frontmatter title as h1, status and actions on the same
              row. `headingHtml` comes from the body HTML, which the markdown
              pipeline has already sanitized — injecting it here is as safe as
              rendering the body. The meta line below is a <div>, not a <p>: the
              breadcrumb is a <nav>, which a <p> must not contain. The section
              position of the running head is not shown in this mode. */}
          <header className="doc-head">
            {headingHtml !== null ? (
              <h1 className="doc-head__title" dangerouslySetInnerHTML={{ __html: headingHtml }} />
            ) : (
              <h1 className="doc-head__title">{data.title}</h1>
            )}
            <div className="doc-head__actions">{statusAndActions}</div>
          </header>
          <div className="metaline">
            <Breadcrumb crumbs={crumbs} ariaLabel={t('read.breadcrumbAriaLabel')} />
            {metaItems}
          </div>
        </>
      ) : (
        <>
          {/* Kolumnentitel (Erscheinungsbild 2026, Etappe 3; Entwurf `.runhead` in
              `docs/design/mockups-2026/editorial.html`, Spec-Abschnitt
              „Kolumnentitel"): Brotkrumenpfad und Positionsanzeige — sonst nichts.
              Der Pfad stand bis hierher in der `.toolbar` und teilte die Zeile mit
              Statusmarke und „Bearbeiten"; die Statusmarke/Aktion bleiben dort (sie
              sind das Pendant zur `.doc__meta`-Zeile des Entwurfs), der Pfad zieht
              in seine eigene Zeile. Die Leisten-Schalter gehören ausdrücklich NICHT
              hierher — sie stehen als Daumenregister in den Außenspalten des
              Rasters (`app/pane-edges.tsx`, `styles/60-chrome-raster.css`). */}
          <div className="runhead">
            <Breadcrumb crumbs={crumbs} ariaLabel={t('read.breadcrumbAriaLabel')} />
            <ReadingPosition slugs={sections} />
          </div>

          <div className="toolbar">
            <span className="grow" />
            {statusAndActions}
          </div>

          <div className="subbar">{metaItems}</div>
        </>
      )}

      {hasNotices ? (
        <div className="notices">
          {isStrictlyConfidential ? (
            <div className="notice warn classification-banner" role="note">
              <span className="ic">{WARN_ICON}</span>
              <div className="txt">
                <b>{t('read.classification.banner')}</b>
              </div>
            </div>
          ) : null}
          {hasDraftNotice ? (
            <div className="notice draft" role="status">
              <span className="ic">{DRAFT_ICON}</span>
              <div className="txt">
                {workflow!.state === 'review' ? t('read.notices.draftInReview') : t('read.notices.draftPending')}
              </div>
              <span className="grow" />
              <a
                href={
                  workflow!.state === 'review'
                    ? wikiPageReviewHref(data.space, data.id)
                    : wikiPageEditHref(data.space, data.id)
                }
              >
                {t('read.notices.viewDraft')}
              </a>
            </div>
          ) : null}

          {hasLockNotice ? (
            <div className="notice lock" role="status">
              <span className="who">{initials(workflow!.lock!.user)}</span>
              <span className="ic">{LOCK_ICON}</span>
              <div className="txt">
                <b>{workflow!.lock!.user}</b> {t('read.notices.lockedBySuffix')}
              </div>
            </div>
          ) : null}

          {hasFrontmatterIssue ? (
            <div className="notice warn" role="status">
              <span className="ic">{WARN_ICON}</span>
              <div className="txt">
                <b>
                  {data.errorStatus === 'parse_error'
                    ? t('read.notices.parseErrorTitle')
                    : t('read.notices.frontmatterTitle')}
                </b>
                {data.frontmatterErrors.length > 0 ? (
                  <ul className="notice-list">
                    {data.frontmatterErrors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                ) : (
                  <span>{t('read.notices.frontmatterFallback')}</span>
                )}
              </div>
            </div>
          ) : null}

          {hasBrokenLinks ? (
            <div className="notice broken" role="status">
              <span className="ic">{WARN_ICON}</span>
              <div className="txt">
                <b>{t('read.notices.brokenLinks', { count: data.brokenLinks.length })}</b>
                <ul className="notice-list">
                  {data.brokenLinks.map((target, i) => (
                    <li key={i}>
                      <code>{target}</code>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="body">
        <PageBody html={bodyHtml} />
      </div>

      {statusBar ? (
        <StatusBarBottom>
          {statusChip}
          {updatedItem}
          {/* Same source as the running head: server-side section slugs. */}
          <ReadingPosition slugs={sections} />
        </StatusBarBottom>
      ) : null}
    </main>
  )
}
