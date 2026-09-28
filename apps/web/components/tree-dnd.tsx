'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { reorderChildren } from '../lib/editor/client-api'
import { apiErrorText } from '../lib/i18n/api-error-text.js'
import { useT } from '../lib/i18n/provider.js'

export interface SiblingListProps {
  space: string
  /** Elternknoten, dessen Kinder diese Liste sind — `null` = Space-Wurzel
   *  (`.order`-Datei an der Repo-Wurzel, s. Server-Kommentar
   *  `routes/reorder.ts`). */
  parentId: string | null
  /** Ids der Kinder in AKTUELLER Server-Reihenfolge — parallel zu `children`
   *  (gleicher Index = dasselbe Kind). */
  childIds: readonly string[]
  /** Die bereits gerenderten Baum-Knoten, ein Element je Id, in DERSELBEN
   *  Reihenfolge wie `childIds` (RSC-Komposition, s. Modul-Kommentar unten). */
  children: readonly ReactNode[]
}

const DRAG_MIME_PREFIX = 'application/x-f451-order-'

/** Eigener MIME-Typ je Geschwister-Ebene (Space + Elternknoten) — verhindert,
 *  dass ein aus einer ANDEREN Ebene gezogenes Element hier abgelegt werden
 *  kann (s. Modul-Kommentar). Browser lowercasen `dataTransfer`-Formatstrings
 *  beim `setData`-Aufruf automatisch; hier defensiv selbst lowercased, damit
 *  der spätere `.types.includes(...)`-Vergleich unabhängig davon immer trifft. */
function dragType(space: string, parentId: string | null): string {
  return `${DRAG_MIME_PREFIX}${space}-${parentId ?? 'root'}`.toLowerCase()
}

/** Verschiebt ein Element von `from` nach `to` (Zielposition IM ORIGINAL-Array
 *  gemeint — „vor das Element, das aktuell an Position `to` steht"). */
function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const copy = [...list]
  const [item] = copy.splice(from, 1)
  const insertAt = from < to ? to - 1 : to
  copy.splice(insertAt, 0, item)
  return copy
}

/** `httpStatus` ist der NUMERISCHE HTTP-Status aus `ReorderChildrenResult` —
 *  die UI zeigt daraus nur noch den lokalisierten Text zum Status-Code
 *  (`errors.*` via {@link apiErrorText}), NICHT mehr den rohen deutschen
 *  `result.error` (Phase 4, „API-Fehler-Mapping"). `{ kind: 'network' }` ist
 *  der gefangene Fetch-Fehler (kein HTTP-Status aus einer Antwort, s.
 *  `handleDrop`s `.catch` weiter unten). */
type ReorderError = { kind: 'status'; httpStatus: number } | { kind: 'network' }

/**
 * Drag&Drop-Umsortierung EINER Geschwister-Ebene (Phase 3.3, „Baum-
 * Umsortierung über `.order`-Dateien"): natives HTML5-DnD
 * (`draggable`/`onDragStart`/`onDragOver`/`onDrop`, KEINE zusätzliche Lib).
 * Der Baum selbst bleibt eine Server Component (`components/tree.tsx`, s.
 * dortiger Kommentar zu `ActiveLink`) — dieser schmale Client-Wrapper bekommt
 * die BEREITS server-gerenderten Knoten als `children` gereicht (RSC-
 * Komposition: eine Server Component darf Client-Komponenten rendern und
 * ihnen server-gerenderte JSX als `children`/Slot-Props mitgeben) und ordnet
 * nur ihre REIHENFOLGE lokal um — die Knoten selbst (inkl. verschachtelter
 * Unterbäume samt ihrer EIGENEN `SiblingList` für tiefere Ebenen) werden dabei
 * nicht neu gerendert, nur an einer neuen Position platziert.
 *
 * DnD nur INNERHALB dieser einen Ebene (Design-Vorgabe Phase 3.3): der
 * `dragType`-MIME-Typ ist je Space+Elternknoten eindeutig — `onDragOver`
 * erlaubt einen Drop nur, wenn der gezogene Typ zur EIGENEN Ebene passt
 * (`event.dataTransfer.types` ist während `dragover` lesbar, der Wert selbst
 * erst bei `drop`). Ein Element aus einer anderen Ebene (anderer Elternknoten)
 * kann dadurch hier nicht abgelegt werden — Verschieben zwischen Eltern ist
 * Move (Phase 3.2), hier bewusst NICHT unterstützt. Verschachtelte Ebenen
 * lösen sich dabei von selbst korrekt auf: der Browser sucht beim Hit-Test
 * den NÄCHSTEN `draggable`-Vorfahren ab der Zeigerposition, ein Ziehen
 * innerhalb einer tieferen Ebene startet also automatisch DEREN Drag, nicht
 * den der äußeren.
 *
 * Optimistisch: die Reihenfolge wird SOFORT lokal übernommen, danach
 * {@link reorderChildren} aufgerufen — bei Erfolg `router.refresh()` (frischer
 * Server-Stand, u. a. relevant für andere Nutzer/Tabs), bei Fehler wird auf
 * die ursprüngliche Reihenfolge zurückgerollt und eine Meldung angezeigt.
 */
export function SiblingList({ space, parentId, childIds, children }: SiblingListProps) {
  const { t } = useT()
  const router = useRouter()
  const [order, setOrder] = useState<string[]>([...childIds])
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [error, setError] = useState<ReorderError | null>(null)

  // Server-Reihenfolge nachziehen (z. B. nach `router.refresh()` mit neuem
  // Stand, oder wenn eine andere Person/ein anderer Tab umsortiert hat) —
  // nur der INHALT (nicht die Array-Referenz) entscheidet, `childIds` ist bei
  // jedem Server-Rendering ein neues Array-Objekt.
  const idsKey = childIds.join(' ')
  useEffect(() => {
    setOrder([...childIds])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  const byId = new Map<string, ReactNode>(childIds.map((id, i) => [id, children[i]]))
  const type = dragType(space, parentId)

  async function handleDrop(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null)
      return
    }
    const previous = order
    const next = moveItem(order, dragIndex, targetIndex)
    setOrder(next)
    setDragIndex(null)
    setError(null)

    const result = await reorderChildren(space, parentId, next).catch(() => null)
    if (result === null) {
      setOrder(previous)
      setError({ kind: 'network' })
      return
    }
    if (!result.ok) {
      setOrder(previous)
      setError({ kind: 'status', httpStatus: result.status })
      return
    }
    router.refresh()
  }

  return (
    <div className="nav">
      {error ? (
        <div className="callout error" role="alert">
          <p>{error.kind === 'network' ? t('actions.reorder.genericError') : apiErrorText(t, error.httpStatus)}</p>
        </div>
      ) : null}
      {order.map((id, index) => (
        <div
          key={id}
          draggable
          className={dragIndex === index ? 'dragging' : undefined}
          onDragStart={(event) => {
            event.stopPropagation()
            event.dataTransfer.setData(type, String(index))
            event.dataTransfer.effectAllowed = 'move'
            setDragIndex(index)
          }}
          onDragEnd={(event) => {
            event.stopPropagation()
            setDragIndex(null)
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(type)) return
            event.stopPropagation()
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.types.includes(type)) return
            event.stopPropagation()
            event.preventDefault()
            void handleDrop(index)
          }}
        >
          {byId.get(id)}
        </div>
      ))}
    </div>
  )
}
