import { describe, expect, it } from 'vitest'
import { t as translate } from './i18n/format.js'
import { de } from './i18n/messages/de/index.js'
import { en } from './i18n/messages/en/index.js'
import type { DotPaths, Params } from './i18n/format.js'
import type { Messages } from './i18n/types.js'
import { buildBreadcrumb, formatUpdatedAt, pageStatusLabel, relationLabel, sectionSlugs } from './page-view.js'

const tDe = (key: DotPaths<Messages>, params?: Params) => translate(de, key, params)
const tEn = (key: DotPaths<Messages>, params?: Params) => translate(en, key, params)

describe('buildBreadcrumb', () => {
  it('Space (verlinkt) → Verzeichnisse → Titel; letztes Pfadsegment ersetzt der Titel', () => {
    const crumbs = buildBreadcrumb('betrieb', 'runbooks/deployment.md', 'Deployment')
    expect(crumbs).toEqual([
      { label: 'betrieb', href: '/wiki/betrieb' },
      { label: 'runbooks' },
      { label: 'Deployment' },
    ])
  })

  it('humanisiert Verzeichnisse (Bindestriche/Unterstriche → Leerzeichen)', () => {
    const crumbs = buildBreadcrumb('demo', 'ci_cd/deploy-runbooks/x.md', 'X')
    expect(crumbs.map((c) => c.label)).toEqual(['demo', 'ci cd', 'deploy runbooks', 'X'])
  })

  it('Pfad ohne Verzeichnis → nur Space + Titel', () => {
    expect(buildBreadcrumb('demo', 'deployment.md', 'Deployment')).toEqual([
      { label: 'demo', href: '/wiki/demo' },
      { label: 'Deployment' },
    ])
  })

  it('leerer Pfad → nur Space + Titel', () => {
    expect(buildBreadcrumb('demo', '', 'Deployment')).toEqual([
      { label: 'demo', href: '/wiki/demo' },
      { label: 'Deployment' },
    ])
  })

  it('letzter Verzeichnis-Krümel entfällt, wenn er (humanisiert) dem Titel entspricht (Redundanz)', () => {
    const crumbs = buildBreadcrumb('betrieb', 'kerneltausch-alt/index.md', 'Kerneltausch alt')
    expect(crumbs).toEqual([
      { label: 'betrieb', href: '/wiki/betrieb' },
      { label: 'Kerneltausch alt' },
    ])
  })

  it('Vergleich ist case-insensitiv', () => {
    const crumbs = buildBreadcrumb('betrieb', 'DEPLOYMENT/index.md', 'deployment')
    expect(crumbs.map((c) => c.label)).toEqual(['betrieb', 'deployment'])
  })

  it('nur der LETZTE Verzeichnis-Krümel wird geprüft — ein gleichnamiges Verzeichnis weiter oben im Pfad bleibt erhalten', () => {
    const crumbs = buildBreadcrumb('betrieb', 'deployment/runbooks/notes.md', 'Deployment')
    expect(crumbs.map((c) => c.label)).toEqual(['betrieb', 'deployment', 'runbooks', 'Deployment'])
  })

  it('kein Match (unterschiedlicher Ordner-/Titelname) → Verzeichnis-Krümel bleibt unverändert', () => {
    const crumbs = buildBreadcrumb('betrieb', 'runbooks/deployment.md', 'Deployment')
    expect(crumbs.map((c) => c.label)).toEqual(['betrieb', 'runbooks', 'Deployment'])
  })
})

describe('relationLabel', () => {
  it('kennt gängige Relationstypen (DE)', () => {
    expect(relationLabel(tDe, 'depends_on')).toBe('Hängt ab von')
    expect(relationLabel(tDe, 'supersedes')).toBe('Ersetzt')
  })

  it('kennt gängige Relationstypen (EN)', () => {
    expect(relationLabel(tEn, 'depends_on')).toBe('Depends on')
    expect(relationLabel(tEn, 'supersedes')).toBe('Supersedes')
  })

  it('fällt für unbekannte Typen auf humanisiert + Großbuchstabe zurück (locale-unabhängig)', () => {
    expect(relationLabel(tDe, 'blocked_by')).toBe('Blocked by')
    expect(relationLabel(tEn, 'blocked_by')).toBe('Blocked by')
  })
})

describe('formatUpdatedAt', () => {
  it('formatiert ISO nach de (TT.MM.JJJJ)', () => {
    expect(formatUpdatedAt('2026-07-06T09:30:00.000Z', 'de')).toBe('06.07.2026')
  })

  it('formatiert ISO nach en (MM/DD/YYYY)', () => {
    expect(formatUpdatedAt('2026-07-06T09:30:00.000Z', 'en')).toBe('07/06/2026')
  })

  it('gibt bei ungültigem Wert den Rohwert zurück', () => {
    expect(formatUpdatedAt('nicht-ein-datum', 'de')).toBe('nicht-ein-datum')
  })
})

describe('pageStatusLabel', () => {
  it('workflow.state schlägt archived — "In Review" auch für eine (davor) released Seite', () => {
    expect(pageStatusLabel(tDe, false, 'review')).toBe('In Review')
    expect(pageStatusLabel(tDe, true, 'review')).toBe('In Review')
  })

  it('workflow.state "working" → "Entwurf", unabhängig von archived', () => {
    expect(pageStatusLabel(tDe, false, 'working')).toBe('Entwurf')
    expect(pageStatusLabel(tDe, true, 'working')).toBe('Entwurf')
  })

  it('ohne workflow (null) fällt auf den bestehenden archived-Fall zurück', () => {
    expect(pageStatusLabel(tDe, false, null)).toBe('Released')
    expect(pageStatusLabel(tDe, true, null)).toBe('Archiviert')
  })

  it('EN: übersetzt alle Status-Label', () => {
    expect(pageStatusLabel(tEn, false, 'review')).toBe('In review')
    expect(pageStatusLabel(tEn, false, 'working')).toBe('Draft')
    expect(pageStatusLabel(tEn, false, null)).toBe('Released')
    expect(pageStatusLabel(tEn, true, null)).toBe('Archived')
  })
})

describe('sectionSlugs', () => {
  it('zählt die h2-Überschriften der ganzen Seite (nicht die Unterebenen)', () => {
    expect(
      sectionSlugs([
        { depth: 1, slug: 'titel' },
        { depth: 2, slug: 'eins' },
        { depth: 3, slug: 'eins-a' },
        { depth: 2, slug: 'zwei' },
        { depth: 4, slug: 'zwei-a-i' },
        { depth: 2, slug: 'drei' },
      ]),
    ).toEqual(['eins', 'zwei', 'drei'])
  })

  it('nimmt die oberste vorkommende Ebene, wenn die Seite erst bei h3 beginnt', () => {
    expect(
      sectionSlugs([
        { depth: 3, slug: 'a' },
        { depth: 4, slug: 'a-1' },
        { depth: 3, slug: 'b' },
      ]),
    ).toEqual(['a', 'b'])
  })

  it('liefert eine leere Liste ohne Überschriften (Positionsanzeige entfällt dann)', () => {
    expect(sectionSlugs([])).toEqual([])
    expect(sectionSlugs([{ depth: 1, slug: 'nur-titel' }])).toEqual([])
  })
})
