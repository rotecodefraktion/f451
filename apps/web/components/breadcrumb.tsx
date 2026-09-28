import { Fragment } from 'react'
import type { Crumb } from '../lib/page-view'

/**
 * Brotkrumenpfad des Kolumnentitels (Erscheinungsbild 2026, Etappe 3).
 *
 * Struktur 1:1 aus `docs/design/mockups-2026/editorial.html` (`.crumbs`),
 * Begründung: `docs/superpowers/specs/2026-07-26-erscheinungsbild-2026-design.md`,
 * Abschnitt „Kolumnentitel".
 *
 * Der Pfad bleibt IMMER einzeilig. Reicht der Platz nicht, ziehen sich die
 * Zwischenebenen zu „…" zusammen — sichtbar, nicht im Zugänglichkeitsbaum:
 *
 *   • Die Zwischenebenen stehen in einem eigenen Träger `.crumbs__mid`. Der
 *     ist im Regelfall `display: contents` (erzeugt keinen Kasten, die Glieder
 *     stehen also direkt im Flex-Satz) und wird beim Kürzen per sr-only-Technik
 *     verborgen — NIE per `display: none`, sonst fiele der vollständige Pfad
 *     aus dem Zugänglichkeitsbaum (Spec „Zugesicherte Eigenschaften" Nr. 2).
 *   • An seine Stelle tritt das rein dekorative `.crumbs__more` („… /",
 *     `aria-hidden`), das im Regelfall gar nicht gerendert wird
 *     (`display: none` ist hier zulässig: es trägt keine Information, die
 *     nicht schon im vollständigen Pfad steht).
 *   • Umgeschaltet wird ausschließlich in CSS über die zwei Schalter-Tokens
 *     `--crumbs-mid`/`--crumbs-more` (Kürzungsleiter in `61-lese.css`) — diese
 *     Komponente kennt keine Breiten und braucht kein JavaScript.
 *
 * Beide Kürzungs-Elemente entstehen nur, wenn es überhaupt Zwischenebenen
 * gibt: bei einem zweigliedrigen Pfad (Space / Titel) darf kein „…" auftauchen,
 * wo nichts verborgen ist.
 */
export function Breadcrumb({ crumbs, ariaLabel }: { crumbs: Crumb[]; ariaLabel: string }) {
  if (crumbs.length === 0) return null
  const first = crumbs.length > 1 ? crumbs[0]! : null
  const mid = crumbs.slice(1, -1)
  const last = crumbs[crumbs.length - 1]!

  return (
    <nav className="crumbs" aria-label={ariaLabel}>
      {first ? (
        <>
          <CrumbLabel crumb={first} />
          <Separator />
        </>
      ) : null}
      {mid.length > 0 ? (
        <>
          <span className="crumbs__mid">
            {mid.map((crumb, i) => (
              <Fragment key={`${crumb.label}-${i}`}>
                <CrumbLabel crumb={crumb} />
                <Separator />
              </Fragment>
            ))}
          </span>
          {/* Der Titel nennt die verborgenen Ebenen auch dem Mauszeiger; für
              die Vorlesehilfe steht der vollständige Pfad ohnehin oben. */}
          <span className="crumbs__more" aria-hidden="true" title={mid.map((c) => c.label).join(' / ')}>
            {'… /'}
          </span>
        </>
      ) : null}
      <span className="here" aria-current="page">
        {last.label}
      </span>
    </nav>
  )
}

function Separator() {
  return (
    <span className="sep" aria-hidden="true">
      /
    </span>
  )
}

/** Ein Glied: verlinkt, wenn ein Ziel bekannt ist (aktuell nur der Space —
 *  für Ordner gibt es keine Seiten-Id, s. `lib/page-view.ts#buildBreadcrumb`). */
function CrumbLabel({ crumb }: { crumb: Crumb }) {
  return crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span>{crumb.label}</span>
}
