import { describe, expect, it } from 'vitest'
import { buildTemplateFileContent, parseTemplateId, templatePath } from '../src/templates/registry.js'

// Reine Funktionstests OHNE Container (Muster `templates-render.test.ts`) —
// `parseTemplateId`/`buildTemplateFileContent`/`templatePath` haben keine
// I/O-Abhängigkeit, die Provider-/Auth-Pfade rund um PATCH/DELETE sind
// weiterhin in `templates.test.ts` (echter Forgejo-Container) abgedeckt
// (Vorlagen-Pflege, Werkzeuge-Bereich „Vorlagen").

describe('templatePath', () => {
  it('hängt das _templates/-Verzeichnis und die .md-Endung an', () => {
    expect(templatePath('meeting-notiz')).toBe('_templates/meeting-notiz.md')
  })
})

describe('parseTemplateId', () => {
  it('space:<id> und global:<id> werden korrekt zerlegt', () => {
    expect(parseTemplateId('space:meeting-notiz')).toEqual({ source: 'space', idPart: 'meeting-notiz' })
    expect(parseTemplateId('global:adr')).toEqual({ source: 'global', idPart: 'adr' })
  })

  it('erlaubt Punkt/Unterstrich/Bindestrich im Id-Teil', () => {
    expect(parseTemplateId('space:v1.2_final-draft')).toEqual({ source: 'space', idPart: 'v1.2_final-draft' })
  })

  it('fehlender Doppelpunkt → null', () => {
    expect(parseTemplateId('meeting-notiz')).toBeNull()
  })

  it('unbekannte Quelle → null', () => {
    expect(parseTemplateId('unsinn:meeting-notiz')).toBeNull()
  })

  it('Pfad-Traversal-Versuche → null (Groß-/Kleinschreibung, Slash, ".." )', () => {
    expect(parseTemplateId('space:../index')).toBeNull()
    expect(parseTemplateId('space:..')).toBeNull()
    expect(parseTemplateId('space:a/b')).toBeNull()
    expect(parseTemplateId('space:Meeting-Notiz')).toBeNull()
    expect(parseTemplateId('space:')).toBeNull()
  })
})

describe('buildTemplateFileContent', () => {
  it('baut Frontmatter (title/description) + Body, Body endet auf genau einen Zeilenumbruch', () => {
    const content = buildTemplateFileContent({
      name: 'Runbook-Gerüst',
      description: 'Störungs-Ablauf',
      body: '# {{titel}}\n\nSchritte …',
    })
    expect(content).toBe('---\ntitle: Runbook-Gerüst\ndescription: Störungs-Ablauf\n---\n\n# {{titel}}\n\nSchritte …\n')
  })

  it('ohne description: kein description-Feld im Frontmatter', () => {
    const content = buildTemplateFileContent({ name: 'Nur-Titel', body: '# X\n' })
    expect(content).toBe('---\ntitle: Nur-Titel\n---\n\n# X\n')
  })

  it('entfernt ein vorhandenes Seiten-Frontmatter aus dem Body (splitFrontmatter)', () => {
    const content = buildTemplateFileContent({
      name: 'Aus Editor',
      body: '---\ntitle: Alt\n---\n\n# Inhalt\n',
    })
    expect(content).toBe('---\ntitle: Aus Editor\n---\n\n# Inhalt\n')
  })
})
