import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import type { MarkdownDiff } from '@f451/markdown'
import { DiffView } from '../../../../../../components/review/diff-view'
import { ReviewView } from '../../../../../../components/review/review-view'
import { ApiError, apiFetch } from '../../../../../../lib/api'
import { getT } from '../../../../../../lib/i18n/server.js'
import { changedBlocks, dchangeModifierClass, railLabel } from '../../../../../../lib/review/diff-view-model'
import { decodeRouteParam, wikiPageReviewHref, wikiSpaceHref } from '../../../../../../lib/urls'

interface ReviewPageProps {
  params: Promise<{ space: string; pageId: string }>
}

/** Antwort-Shape von `GET /api/pages/:id/review` (Phase 2d Task 4, s.
 *  `apps/api/src/routes/workflow.ts#reviewGetSchema`). `diff` ist hier —
 *  anders als in `lib/editor/client-api.ts#ReviewDiffInfo` (Task 6, dort
 *  bewusst `unknown` belassen) — voll typisiert: diese Route rendert sie
 *  tatsächlich, das duplizierte Typ-Modell entfällt durch den Import aus
 *  `@f451/markdown` (bereits Abhängigkeit von `@f451/web`, s.
 *  `components/editor/editor-root.tsx`).
 *
 *  `versioning`/`version` (Befund 3, Final-Review): liefert dieselbe Route
 *  jetzt MIT (`apps/api/src/routes/workflow.ts#reviewGetSchema`) — vorher ein
 *  ZWEITER, fehler-toleranter Fetch auf `GET /api/pages/:id` (`.catch(() =>
 *  null)`), dessen Ausfall den Versionsabschnitt lautlos verschwinden ließ,
 *  ohne dass der Freigebende davon erfuhr und stattdessen mit dem
 *  Server-Default `patch` freigab. */
interface ReviewResponse {
  pr: { number: number; url: string; state: string; mergeable: boolean | null; title: string }
  authorName: string
  diff: MarkdownDiff
  page: { id: string; space: string; title: string }
  versioning: boolean
  version?: string
  /** `version` is the implicit 0.1.0 (page on main, never released with a version). */
  implicitVersion?: boolean
}

const CLOCK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const GIT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M6 8.5v7M18 15.5V12a4 4 0 0 0-4-4H9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const ADD_SUMMARY_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} aria-hidden="true">
    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
  </svg>
)

const CHG_SUMMARY_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
    <path d="M4 20h4L18 10l-4-4L4 16z" strokeLinejoin="round" />
  </svg>
)

const RM_SUMMARY_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} aria-hidden="true">
    <path d="M5 12h14" strokeLinecap="round" />
  </svg>
)

/** Initialen aus dem Anzeigenamen — identisch zu `page-view.tsx#initials`
 *  (bewusst lokal dupliziert statt einer geteilten Utility für eine einzige
 *  4-Zeilen-Funktion, s. dortiger Kommentar). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase()
}

const CHANGE_ICON_BY_KIND: Record<'add' | 'chg' | 'rm', typeof ADD_SUMMARY_ICON> = {
  add: ADD_SUMMARY_ICON,
  chg: CHG_SUMMARY_ICON,
  rm: RM_SUMMARY_ICON,
}

/**
 * Review-Seite einer Wiki-Seite — visueller Diff, Freigabe-Aktionen,
 * Konflikt-Aktualisierung (Phase 2d Task 7). Server Component, Muster
 * `[pageId]/page.tsx`/`[pageId]/edit/page.tsx`: `apiFetch` mit
 * durchgereichtem Session-Cookie, `404` (KEIN offenes Review ODER die
 * normale Gate-Kette — beide Fälle liefern serverseitig `404`, s.
 * `apps/api/src/routes/workflow.ts` „GET /review") → Next `notFound()`,
 * jeder andere Fehler → Fehlerkarte mit Retry. Keine gesonderte
 * Nicht-Berechtigt-UI: dieselbe Gate-Kette wie der Editor liefert bereits
 * `404`/`403`, s. Brief.
 *
 * `GET .../review` liefert `page: {id, space, title}` OHNE `path` — die
 * Breadcrumb bleibt deshalb zweistufig (Space · Titel), anders als
 * `lib/page-view.ts#buildBreadcrumb` (das Verzeichnissegmente aus `path`
 * bräuchte, den diese Route nicht hat und dafür keinen zweiten API-Aufruf
 * wert ist).
 */
export default async function ReviewPage({ params }: ReviewPageProps) {
  const { space: rawSpace, pageId: rawPageId } = await params
  const spaceId = decodeRouteParam(rawSpace)
  const pageId = decodeRouteParam(rawPageId)

  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString() || undefined
  const { t } = await getT()

  let data: ReviewResponse
  try {
    // Befund 3 (Final-Review): kein zweiter Fetch mehr für `versioning`/
    // `version` — `GET .../review` liefert sie jetzt selbst mit (s.
    // `ReviewResponse`-Kommentar oben). Ein Ausfall dieses EINEN Fetches
    // führt weiterhin zur gewohnten Fehlerkarte/404 unten, statt den
    // Versionsabschnitt lautlos verschwinden zu lassen.
    data = await apiFetch<ReviewResponse>(`/api/pages/${encodeURIComponent(pageId)}/review`, {
      cookie: cookieHeader,
    })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound()
    }
    return (
      <main className="main" style={{ padding: 'var(--space-6) var(--space-7)' }}>
        <div className="callout error" role="alert">
          <p>{t('review.loadError')}</p>
          <div className="btn-row">
            <a href={wikiPageReviewHref(spaceId, pageId)}>{t('review.retry')}</a>
          </div>
        </div>
      </main>
    )
  }

  const { pr, authorName, diff, page } = data
  const changes = changedBlocks(diff.blocks)

  return (
    <>
      <main className="main">
        <div className="rhead">
          <span className="crumbs">
            <a href={wikiSpaceHref(spaceId)}>{spaceId}</a>
            <span className="sep">/</span>
            <b aria-current="page">{page.title}</b>
          </span>
          <div className="rtitle">
            <h1>{page.title}</h1>
            <span className="pr">#{pr.number}</span>
            <span className="chip review">
              {CLOCK_ICON}
              {t('review.status.review')}
            </span>
          </div>
          <div className="rmeta">
            <span className="who">
              <span className="uav">{initials(authorName)}</span>
              {t('review.author')} <b>{authorName}</b>
            </span>
            <span className="grow" />
            {/* Provider-neutraler Linktext (Space kann Forgejo ODER GitHub
                sein, s. `apps/api/src/spaces/`) — das Mockup nimmt Forgejo
                als Demo-Fixpunkt an, hier ist der Provider pro Space
                konfigurierbar. */}
            <a
              className="rlink"
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              title={t('review.openPr')}
            >
              {GIT_ICON}
              {t('review.openPr')}
            </a>
          </div>
        </div>

        <DiffView diff={diff} />

        <ReviewView
          pageId={pageId}
          space={spaceId}
          pr={pr}
          versioning={data.versioning}
          currentVersion={data.version}
          implicitVersion={data.implicitVersion}
        />
      </main>

      {/* `id="pane-rail"` — Ziel des `aria-controls` am rechten Daumenregister
          (`app/pane-edges.tsx`), das auch diese Leiste ein- und ausklappt. */}
      <aside className="rail" id="pane-rail" aria-label={t('review.rail.ariaLabel')}>
        <section className="rp">
          <h4>{t('review.rail.changesHeading')}</h4>
          {/* Teilschritt I: die drei Zusammenfassungs-Marken waren die
              Eigenklasse `.rsum .s` (drei der 17 aus Bestandsaufnahme §2.3)
              und hingen als Alias am `.chip`. Jetzt tragen sie den Baustein
              selbst. */}
          <div className="rsum">
            <span className="chip released">
              {ADD_SUMMARY_ICON}
              {diff.summary.added}
            </span>
            <span className="chip review">
              {CHG_SUMMARY_ICON}
              {diff.summary.changed}
            </span>
            <span className="chip error">
              {RM_SUMMARY_ICON}
              {diff.summary.removed}
            </span>
          </div>
          {changes.length > 0 ? (
            <ul className="changes">
              {changes.map((block) => {
                const modifier = dchangeModifierClass(block.kind) ?? 'rm'
                return (
                  <li key={block.anchor}>
                    <a className={modifier} href={`#${block.anchor}`}>
                      <span className="ci">{CHANGE_ICON_BY_KIND[modifier]}</span>
                      <span className="cl">
                        <b>{railLabel(t, block)}</b>
                      </span>
                    </a>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </section>
        <section className="rp">
          <h4>{t('review.rail.prHeading')}</h4>
          <dl className="meta">
            <dt>{t('review.rail.fields.status')}</dt>
            <dd>
              <span className="mini-rev">{t('review.status.review')}</span>
            </dd>
            <dt>{t('review.rail.fields.source')}</dt>
            <dd>
              {/* Näherung: der tatsächliche Branch-Name (`draftBranchName`,
                  `apps/api/src/drafts/branch-name.ts`) hängt bei
                  git-unsicheren Ids (`:`/`/`, z. B. `path:<space>/<datei>.md`)
                  einen Hash-Suffix an — die API liefert hier nur `page.id`,
                  kein `branch`-Feld. Rein informative Anzeige (Mockup:
                  "Quelle draft/<id>"), keine navigierbare Referenz. */}
              <code>draft/{page.id}</code>
            </dd>
            <dt>{t('review.rail.fields.target')}</dt>
            <dd>
              <code>main</code>
            </dd>
            <dt>{t('review.rail.fields.author')}</dt>
            <dd>{authorName}</dd>
            <dt>{t('review.rail.fields.number')}</dt>
            <dd>#{pr.number}</dd>
          </dl>
        </section>
      </aside>
    </>
  )
}
