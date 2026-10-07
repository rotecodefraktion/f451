'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { clampPopoverPosition, computeLayout, GRAPH_VIEW, POPOVER_SIZE } from '../../lib/graph/layout'
import { degreeMap, hubIds, nodeVisibility, truncateLabel, visibleEdgeCount } from '../../lib/graph/model'
import { statusShape } from '../../lib/graph/status-shape'
import type { GraphData, GraphEdgeType, GraphNode, GraphNodeStatus } from '../../lib/graph/types'
import { useT } from '../../lib/i18n/provider'
import { isPhoneLayout } from '../../lib/phone'
import { wikiGraphHref, wikiPageHref, wikiSpaceHref } from '../../lib/urls'

export interface GraphViewProps {
  graph: GraphData
  space: string
  spaceName: string
  spaces: Array<{ id: string; name: string }>
}

const EDGE_GROUP: Record<Exclude<GraphEdgeType, 'tag'>, 'hier' | 'link' | 'rel'> = {
  hierarchy: 'hier',
  link: 'link',
  relation: 'rel',
}

/** Reihenfolge der Kantentyp-Umschalter (`.etoggle`) — verbatim aus dem
 *  Mockup. `data-edge`/CSS-Ausblenden nutzen die Kurzform aus
 *  {@link EDGE_GROUP}, der State (`hidden`) speichert die vollen
 *  `GraphEdgeType`-Werte (Brief-Vorgabe, s. `visibleEdgeCount`). Die
 *  Beschriftungen sind lokalisiert (`graph.edges.*`) und werden im Render aus
 *  `t()` aufgelöst. */
const EDGE_TOGGLE_TYPES: Array<Exclude<GraphEdgeType, 'tag'>> = ['hierarchy', 'link', 'relation']

/**
 * Der Knotenpunkt: FORM aus {@link statusShape} (das farbfreie zweite Merkmal
 * je Status, Begründung dort), Farbe aus `.n-* .dot` in `65-graph.css`.
 *
 * Die Klasse heißt für alle vier Formen `dot` — die Statusfarben hängen dort an
 * `.n-* .dot` und gelten damit für `<circle>` wie für `<path>`. Dieselbe
 * Funktion zeichnet die Felder der Legende (nur kleiner): eine Legende, die ein
 * anderes Merkmal zeigt als die Fläche, erklärt nichts.
 */
function statusMark(status: GraphNodeStatus, r: number) {
  const shape = statusShape(status, r)
  if (shape.kind === 'circle') return <circle className="dot" r={shape.r} />
  return <path className="dot" d={shape.d} />
}

/**
 * Graph-Ansicht nach docs/design/mockups/graph.html: statisches SVG, dessen
 * Koordinaten aus einer synchron durchgetickten d3-force-Simulation kommen
 * (useMemo — kein Re-Layout bei reinen Filter-/Auswahl-Änderungen). Die
 * Mockup-Klassen (node/dot/lbl/halo, edges e-hier/e-link/e-rel, elbl, …)
 * werden 1:1 gerendert; Kantentypen unterscheiden sich per Strichstil UND
 * Pfeilform (Nie-Farbe-allein). Hierarchie-Pfeile zeigen vom Elternknoten
 * zum Kind („enthält") — die Kante ist in der DB Kind→Eltern gespeichert,
 * gezeichnet wird sie deshalb gedreht.
 *
 * Task 5 ergänzt die Bedienoberfläche (Filterbar, Legende, Detail-Popover,
 * Minitree-Punkte) — Struktur/Klassen/Wortlaute verbatim aus dem Mockup, mit
 * zwei dokumentierten Abweichungen: die Space-Auswahl kennt keine
 * „+ Nachbarn"/„Alle Spaces"-Optionen (kein Multi-Space-Graph in dieser
 * Phase, nur ein `<select>` je Space aus `spaces`) und das Popover hat weder
 * einen „Im Seitenbaum zeigen"-Knopf (kein Seitenbaum in der Graph-Ansicht)
 * noch „Version" in `.pmeta` — dort steht „Aktualisiert" (der Graph-
 * Datenvertrag liefert `updatedAt`, keine Versionsnummer).
 */
export function GraphView({ graph, space, spaceName, spaces }: GraphViewProps) {
  const { t, locale } = useT()
  // Lokalisierte Status-Beschriftung (ersetzt das deutsche `statusLabel` aus
  // `lib/graph/model.ts` für die ANZEIGE — die Node-Status-Werte selbst
  // bleiben englische Enum-Codes). Literale Keys statt Template-String, damit
  // der Übersetzer-Typ voll greift.
  const statusLabels: Record<GraphNodeStatus, string> = {
    released: t('graph.status.released'),
    review: t('graph.status.review'),
    working: t('graph.status.working'),
    archived: t('graph.status.archived'),
  }
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<GraphEdgeType>>(new Set())
  const [query, setQuery] = useState('')
  const [depth, setDepth] = useState(3)
  const popRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  // Gemessene Pixel-Größe von `.canvas` (Bugfix „Graph-Popover überlappt
  // Rand/Button") — {@link clampPopoverPosition} braucht die tatsächliche
  // Container-Größe, um die %-lose Pixel-Position des Popovers am Rand zu
  // klemmen statt es roh nach der Knoten-Koordinate zu positionieren.
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })

  const positions = useMemo(() => computeLayout(graph), [graph])
  const degrees = useMemo(() => degreeMap(graph), [graph])
  const hubs = useMemo(() => new Set(hubIds(graph)), [graph])
  const hubNodes = useMemo(
    () =>
      hubIds(graph)
        .map((id) => graph.nodes.find((n) => n.id === id))
        .filter((n): n is GraphNode => n != null),
    [graph],
  )
  const visibility = useMemo(
    () => nodeVisibility(graph, { query, selectedId, depth }),
    [graph, query, selectedId, depth],
  )

  const selected = selectedId ? graph.nodes.find((n) => n.id === selectedId) ?? null : null
  const visibleEdges = graph.edges.filter(
    (e) => visibility.get(e.from) !== 'hidden' && visibility.get(e.to) !== 'hidden' && e.type !== 'tag',
  )
  const visibleNodeCount = graph.nodes.filter((n) => visibility.get(n.id) !== 'hidden').length
  const hiddenClasses = EDGE_TOGGLE_TYPES.filter((type) => hidden.has(type)).map((type) => `hide-${EDGE_GROUP[type]}`)

  // Popover übernimmt den Fokus, sobald es erscheint (Screenreader landen
  // direkt im Panel) UND schließt sich auf Escape UNABHÄNGIG vom aktuellen
  // Fokus — ein reiner `onKeyDown` auf dem Wurzel-Element (Brief-Wortlaut)
  // hätte hier eine echte Lücke: sobald der Fokus danach z. B. auf den
  // Tiefe-Slider wandert (Klick/Tab), bubbelt Escape nicht mehr durch das
  // Popover, weil es kein Vorfahre des Slider-Elements ist (Dev-Smoke hat das
  // real reproduziert — Slider bedienen, dann Escape: Popover blieb offen).
  // Der `window`-Listener unten ist deshalb die verlässliche Instanz; der
  // zusätzliche `onKeyDown` auf dem `<aside>` bleibt als zweite, redundante
  // Absicherung erhalten (deckt sich mit dem Wortlaut, doppeltes
  // `setSelectedId(null)` ist harmlos).
  useEffect(() => {
    // On the phone the canvas is hidden (`66-telefon.css`, f451#1) — nothing to focus or close.
    if (!selected || isPhoneLayout()) return
    popRef.current?.focus()
    function onWindowKeyDown(ev: KeyboardEvent) {
      if (ev.key !== 'Escape') return
      // Escape, das einem offenen nativen `<dialog>` (z. B. dem ⌘K-Suchdialog,
      // components/search-dialog.tsx, showModal()) galt, bubbelt bis zu
      // `window` hoch — ohne diese Ausnahme schließt es hier fälschlich auch
      // das Graph-Popover mit (reproduziert: Knoten wählen → ⌘K → Escape →
      // Popover schloss ungewollt). Nur schließen, wenn das Escape NICHT
      // einem offenen Dialog galt.
      if (ev.target instanceof Node && document.querySelector('dialog[open]')?.contains(ev.target)) return
      setSelectedId(null)
    }
    window.addEventListener('keydown', onWindowKeyDown)
    return () => window.removeEventListener('keydown', onWindowKeyDown)
  }, [selected])

  // Verfolgt die Pixel-Größe von `.canvas` (Größenänderung des Fensters/der
  // Sidebar) — `clampPopoverPosition` rechnet damit die Viewbox-Koordinate
  // des ausgewählten Knotens in eine randsichere Pixel-Position um.
  useEffect(() => {
    const el = canvasRef.current
    // Hidden canvas on the phone (f451#1): no size to track.
    if (!el || isPhoneLayout()) return
    const update = () => setCanvasSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  function edgeEndpoints(e: (typeof graph.edges)[number]) {
    // Hierarchie: DB speichert Kind→Eltern, der Pfeil „enthält" zeigt
    // Eltern→Kind — Endpunkte drehen.
    const [fromId, toId] = e.type === 'hierarchy' ? [e.to, e.from] : [e.from, e.to]
    return { a: positions.get(fromId), b: positions.get(toId) }
  }

  // Redesign Phase 3 (Handoff „Graph view/Nodes"): normaler Knoten 18px
  // Durchmesser (r=9), aktiver Knoten 26px (r=13). Der Doppelring des aktiven
  // Knotens entsteht aus `.is-selected .dot` (5px Flächenfarbe) plus dem
  // `.halo`-Kreis darunter (3px Akzent) — dessen Radius muss deshalb
  // 13 + 5 + 3 = 21 sein, s. `graph.css`.
  const nodeRadius = (id: string) => (id === selectedId ? 13 : hubs.has(id) ? 11 : 9)

  function toggleEdge(type: Exclude<GraphEdgeType, 'tag'>) {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  function resetView() {
    setQuery('')
    setHidden(new Set())
    setDepth(3)
    setSelectedId(null)
  }

  const popPos = selected ? positions.get(selected.id) : undefined
  // Randsichere Pixel-Position des Popovers (Bugfix „Graph-Popover überlappt
  // Rand/Button") — ersetzt die bisherige rohe `%`-Positionierung, die an den
  // Canvas-Rändern (wo z. B. „Aktualisiert …" + „Öffnen"-Button sitzen) über
  // `.canvas { overflow: hidden }` hinweg abgeschnitten wurde.
  const clampedPopPos = popPos ? clampPopoverPosition(popPos, canvasSize, POPOVER_SIZE) : undefined
  const edgeTypesAtSelected = selected
    ? new Set(graph.edges.filter((e) => e.from === selected.id || e.to === selected.id).map((e) => e.type)).size
    : 0
  const depthPercent = ((depth - 1) / 3) * 100

  return (
    <>
      <nav className="minitree" aria-label={t('graph.minitree.collapsedAriaLabel', { name: spaceName })}>
        <span className="sq" title={t('graph.minitree.spaceTitle', { name: spaceName })}>{spaceName.charAt(0).toUpperCase() || '?'}</span>
        <Link className="ico" href={wikiSpaceHref(space)} title={t('graph.minitree.listView')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
          </svg>
        </Link>
        <span className="ico active" title={t('graph.minitree.graphActive')} aria-current="page">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx={6} cy={6} r={2.4} />
            <circle cx={18} cy={7} r={2.4} />
            <circle cx={12} cy={17} r={2.4} />
            <path d="M8 7.4 10.6 15M8 6.8 15.6 6.7M16.6 9 13 15" strokeLinecap="round" />
          </svg>
        </span>
        <span className="sep" />
        {hubNodes.map((n) => (
          <button
            key={n.id}
            type="button"
            className="dotm"
            title={`${n.title} · ${statusLabels[n.status]}`}
            style={{ background: `var(--color-status-${n.status})` }}
            onClick={() => setSelectedId(n.id)}
          />
        ))}
        <span className="grow" />
      </nav>

      <section className="stage">
        <div className="filterbar">
          <label className="fsearch">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx={11} cy={11} r={7} />
              <path d="m20 20-3.2-3.2" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              placeholder={t('graph.filter.placeholder')}
              aria-label={t('graph.filter.ariaLabel')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          <span className="fsel">
            {t('graph.filter.spaceLabel')}
            <select
              aria-label={t('graph.filter.spaceSelectAriaLabel')}
              value={space}
              onChange={(e) => router.push(wikiGraphHref(e.target.value))}
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </span>
          <span className="fdiv" />

          <span className="etoggles" role="group" aria-label={t('graph.filter.edgeTogglesAriaLabel')}>
            {EDGE_TOGGLE_TYPES.map((type) => {
              const label = t(`graph.edges.${type}`)
              const off = hidden.has(type)
              return (
                // Der Zustand hängt an EINEM Merkmal. Bis zum Baustein-Umbau
                // trug dieses Element gleichzeitig `class="off"` UND
                // `aria-pressed` — zwei Merkmale für einen Zustand, dieselbe
                // Doppelführung, die beim Editor-Umschalter zu zwei um
                // dasselbe Element streitenden Regeln geführt hat
                // (Bestandsaufnahme §6.2). `45-auswahl.css` legt für
                // Umschalter `aria-pressed` fest und begründet es dort; die
                // Klasse ist damit weg, das CSS liest `[aria-pressed]`.
                <button
                  key={type}
                  type="button"
                  className="chip etoggle"
                  data-edge={EDGE_GROUP[type]}
                  aria-pressed={!off}
                  onClick={() => toggleEdge(type)}
                >
                  <span className="chk" />
                  {type === 'hierarchy' ? (
                    <svg viewBox="0 0 26 8">
                      <line x1={0} y1={4} x2={20} y2={4} stroke="var(--edge-hier)" strokeWidth={1.2} />
                      <path d="M20 1.5 25 4 20 6.5z" fill="var(--edge-hier)" />
                    </svg>
                  ) : type === 'link' ? (
                    <svg viewBox="0 0 26 8">
                      <line x1={0} y1={4} x2={26} y2={4} stroke="var(--edge-link)" strokeWidth={2} />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 26 8">
                      <line
                        x1={0}
                        y1={4}
                        x2={20}
                        y2={4}
                        stroke="var(--edge-rel)"
                        strokeWidth={1.7}
                        strokeDasharray="5 4"
                      />
                      <path d="M20 1.5 25 4 20 6.5z" fill="var(--edge-rel)" />
                    </svg>
                  )}
                  {label}
                </button>
              )
            })}
          </span>

          <span className="grow" />

          <span className="depth" title={t('graph.filter.depthTitle')}>
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx={12} cy={12} r={3} />
              <circle cx={12} cy={12} r={9} />
            </svg>
            {t('graph.filter.depthLabel')}{' '}
            <input
              type="range"
              min={1}
              max={4}
              value={depth}
              aria-label={t('graph.filter.depthAriaLabel')}
              onChange={(e) => setDepth(Number(e.target.value))}
              style={{
                background: `linear-gradient(90deg,var(--color-accent) 0 ${depthPercent}%,var(--color-border-strong) ${depthPercent}%)`,
              }}
            />{' '}
            {/* `.dval`, nicht `.tag`: der abgelesene Zahlenwert ist kein
                Schlagwort. Der alte Name kollidierte mit dem Marken-Baustein
                (`42-marke.css`). */}
            <span className="dval">{depth}</span>
          </span>
          <span className="fdiv" />

          <button className="btn" type="button" title={t('graph.filter.resetTitle')} onClick={resetView}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M4 4v6h6M20 20v-6h-6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M20 10a8 8 0 0 0-14-4M4 14a8 8 0 0 0 14 4" strokeLinecap="round" />
            </svg>
            {t('graph.filter.reset')}
          </button>
        </div>

        <div className="canvas" ref={canvasRef}>
          <svg
            className={['graph', ...hiddenClasses].join(' ')}
            viewBox={`0 0 ${GRAPH_VIEW.width} ${GRAPH_VIEW.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={t('graph.canvasAriaLabel', { name: spaceName, count: graph.nodes.length })}
          >
            <defs>
              <marker id="ah-hier" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="var(--edge-hier)" />
              </marker>
              <marker id="ah-rel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="var(--edge-rel)" />
              </marker>
              <marker id="ah-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path className="hl-arrow" d="M0 0L10 5L0 10z" fill="var(--edge-hl)" />
              </marker>
            </defs>
            {(['hierarchy', 'link', 'relation'] as const).map((type) => (
              <g key={type} className={`edges e-${EDGE_GROUP[type]}`}>
                {visibleEdges
                  .filter((e) => e.type === type)
                  .map((e, i) => {
                    const { a, b } = edgeEndpoints(e)
                    if (!a || !b) return null
                    const isHl = selectedId !== null && (e.from === selectedId || e.to === selectedId)
                    const marker = type === 'link' ? undefined : isHl ? 'url(#ah-hl)' : `url(#ah-${EDGE_GROUP[type]})`
                    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
                    return (
                      <g key={`${e.from}-${e.to}-${e.label}-${i}`}>
                        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={isHl ? 'hl' : undefined} markerEnd={marker} />
                        {type === 'relation' ? (
                          <g className="elbl" transform={`translate(${mid.x},${mid.y})`}>
                            <rect x={-e.label.length * 3.4 - 4} y={-8} width={e.label.length * 6.8 + 8} height={15} rx={4} />
                            <text>{e.label}</text>
                          </g>
                        ) : null}
                      </g>
                    )
                  })}
              </g>
            ))}
            <g className="nodes">
              {graph.nodes.map((n) => {
                const pos = positions.get(n.id)
                const vis = visibility.get(n.id) ?? 'normal'
                if (!pos || vis === 'hidden') return null
                const classes = ['node', `n-${n.status}`]
                if (hubs.has(n.id)) classes.push('is-hub')
                if (n.id === selectedId) classes.push('is-selected')
                if (vis === 'dim') classes.push('dim')
                return (
                  <g
                    key={n.id}
                    className={classes.join(' ')}
                    transform={`translate(${pos.x},${pos.y})`}
                    tabIndex={0}
                    role="button"
                    aria-label={`${n.title} · ${statusLabels[n.status]}`}
                    onClick={() => setSelectedId(n.id === selectedId ? null : n.id)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault()
                        setSelectedId(n.id === selectedId ? null : n.id)
                      }
                    }}
                  >
                    <title>{n.title}</title>
                    {n.id === selectedId ? <circle className="halo" r={21} /> : null}
                    {statusMark(n.status, nodeRadius(n.id))}
                    {(() => {
                      // Label-Hintergrund-Chip + Kürzung (Bugfix „Graph-Label-Overlap"):
                      // ohne Chip überlappen lange Titel (viele 30+ Zeichen) benachbarte
                      // Knoten unlesbar; `.lbl-wrap` ist `pointer-events: none` (graph.css),
                      // damit ein überlappendes Label nie den Klick auf den DOT eines
                      // NACHBAR-Knotens abfängt — der volle Titel bleibt über `<title>`
                      // (oben, nativer SVG-Tooltip) und `aria-label` (s. `<g>`) erreichbar.
                      const label = truncateLabel(n.title)
                      const labelY = nodeRadius(n.id) + 14
                      return (
                        <g className="lbl-wrap">
                          <rect
                            className="lbl-bg"
                            x={-label.length * 3.4 - 4}
                            y={labelY - 10}
                            width={label.length * 6.8 + 8}
                            height={14}
                            rx={4}
                          />
                          <text className="lbl" y={labelY}>{label}</text>
                        </g>
                      )
                    })()}
                  </g>
                )
              })}
            </g>
          </svg>

          <div className="legend card">
            <div className="col">
              <h5>{t('graph.legend.nodesHeading')}</h5>
              {/* Die Legende zeigt DIESELBE Form wie der Knoten — derselbe
                  Aufruf von {@link statusMark}, nur kleiner. Eine Legende, die
                  ein anderes Merkmal zeigt als die Fläche, erklärt nichts. */}
              {(['released', 'review', 'working', 'archived'] as const).map((status) => (
                <span key={status} className="lrow">
                  <svg className={`sw s-${status}`} viewBox="-7 -7 14 14" aria-hidden="true">
                    {statusMark(status, 5)}
                  </svg>
                  {statusLabels[status]}
                </span>
              ))}
            </div>
            <div className="col">
              <h5>{t('graph.legend.edgesHeading')}</h5>
              <span className="lrow">
                <svg viewBox="0 0 30 10">
                  <line x1={0} y1={5} x2={23} y2={5} stroke="var(--edge-hier)" strokeWidth={1.2} />
                  <path d="M23 2 28 5 23 8z" fill="var(--edge-hier)" />
                </svg>
                {t('graph.edges.hierarchy')} <span className="muted">{t('graph.legend.hierarchyHint')}</span>
              </span>
              <span className="lrow">
                <svg viewBox="0 0 30 10">
                  <line x1={0} y1={5} x2={30} y2={5} stroke="var(--edge-link)" strokeWidth={2} />
                </svg>
                {t('graph.edges.link')} <span className="muted">{t('graph.legend.linkHint')}</span>
              </span>
              <span className="lrow">
                <svg viewBox="0 0 30 10">
                  <line x1={0} y1={5} x2={23} y2={5} stroke="var(--edge-rel)" strokeWidth={1.7} strokeDasharray="5 4" />
                  <path d="M23 2 28 5 23 8z" fill="var(--edge-rel)" />
                </svg>
                {t('graph.edges.relation')} <span className="muted">{t('graph.legend.relationHint')}</span>
              </span>
            </div>
          </div>

          {selected && popPos && clampedPopPos ? (
            <aside
              ref={popRef}
              className="pop"
              aria-label={t('graph.popover.ariaLabel', { title: selected.title })}
              tabIndex={-1}
              style={{
                left: `${clampedPopPos.left}px`,
                top: `${clampedPopPos.top}px`,
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSelectedId(null)
              }}
            >
              <div className="ph">
                <div className="t">
                  {selected.title}
                  <small>{t('graph.popover.subtitle', { name: spaceName })}</small>
                </div>
                {/* Teilschritt I: war ein `<span onClick>` — nicht
                    fokussierbar, nicht per Tastatur auslösbar (Befund 4 im
                    Bericht H5). Jetzt ein natives `<button>` mit zugänglichem
                    Namen aus `aria-label`; das `title` bleibt als Tooltip für
                    die Maus. Escape (Fensterebene, s. `onKeyDown` am
                    `<aside>`) funktioniert unverändert. */}
                <button
                  type="button"
                  className="x"
                  aria-label={t('graph.popover.close')}
                  title={t('graph.popover.close')}
                  onClick={() => setSelectedId(null)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              <div className="prow">
                {/* Statusmarke aus `42-marke.css`; Zeichen und Wort stehen
                    beide im Markup — Farbe trägt die Bedeutung nie allein
                    (Spec „Zugesicherte Eigenschaften", Punkt 3).
                    Teilschritt I: Die Variante war auf `released` FESTGENAGELT,
                    samt eingebautem Häkchen — ein Knoten im Entwurf trug also
                    die grüne Marke mit Häkchen und daneben das Wort „Entwurf".
                    Jetzt folgt die Variante dem Status, und das Zeichen kommt
                    aus `--chip-glyph` der Variante (`.chip:not(:has(.glyph,
                    svg, img))::before` in `42-marke.css`) — dieselben vier
                    Zeichen wie im Marken-Baustein, ohne sie hier zu
                    verdoppeln. */}
                <span className={`chip ${selected.status}`}>{statusLabels[selected.status]}</span>
              </div>
              <div className="ptags">
                {selected.tags.map((tag) => (
                  <span key={tag} className="tag"><span className="h">#</span>{tag}</span>
                ))}
              </div>
              <div className="pmeta">
                <div><span>{t('graph.popover.links')}</span><b>{degrees.get(selected.id) ?? 0}</b></div>
                <div><span>{t('graph.popover.edgeTypes')}</span><b>{edgeTypesAtSelected}</b></div>
                <div><span>{t('graph.popover.updated')}</span><b>{new Date(selected.updatedAt).toLocaleDateString(locale)}</b></div>
              </div>
              <div className="pact">
                {/* Hauptaktion des Popovers. `btn primary` statt des alten
                    `.pbtn`: die Hauptaktion steht in Tinte, die Akzentfarbe
                    bleibt der Bedeutung vorbehalten (Bedeutungsumkehr im Kopf
                    von `40-schaltflaeche.css`). */}
                <Link className="btn primary" href={wikiPageHref(space, selected.id)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M14 3h7v7M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {t('graph.popover.open')}
                </Link>
              </div>
            </aside>
          ) : null}

          <div className="hint">
            <b>{visibleNodeCount}</b> {t('graph.hint.nodes')} · <b>{visibleEdgeCount(graph, visibility, hidden)}</b> {t('graph.hint.edges')} · Space <b>{spaceName}</b>
          </div>
        </div>
      </section>
    </>
  )
}
