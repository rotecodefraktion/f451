'use client'

import { useState } from 'react'
import type { EnumField, MetadataField, MetadataSchema, MultiField, PatternField } from '@f451/markdown'
import {
  isFieldMissing,
  isPatternValid,
  type MetadataFormValue,
  type MetadataFormValues,
} from '../../lib/metadata-form'
import { useT } from '../../lib/i18n/provider'

export interface MetadataPanelProps {
  /** Metadaten-Schema des Space (`GET /api/spaces/:space/metadata-schema`,
   *  server-seitig von `edit/page.tsx` geladen, Muster M2/`rail.tsx`). `null`
   *  oder ein Schema ohne Felder → die Komponente rendert nichts (kein
   *  Formular, keine Regression für Seiten ohne Metadaten-Feature). */
  schema: MetadataSchema | null
  /** Aktueller Formular-Zustand (EIN Eintrag pro editierbarem Feld, s.
   *  `lib/metadata-form.ts`) — von `editor-root.tsx` aus `frontmatterRaw`
   *  abgeleitet (`deriveMetadataFormValues`, EINE Quelle). */
  values: MetadataFormValues
  /** Rohe Metadaten-Werte für `'auto'`-Felder (read-only Anzeige, s.
   *  `schema.ts`: die Ableitung selbst ist M3b) — kommt direkt aus dem
   *  geparsten Frontmatter, läuft NICHT über `values` (das enthält nur
   *  editierbare Felder, s. `lib/metadata-form.ts#isEditableField`). */
  autoValues: Record<string, unknown>
  onFieldChange: (key: string, value: MetadataFormValue) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `false` im Roh-Text-Modus (Task-Vorgabe: der Roh-Modus bleibt der
   *  einzige Frontmatter-EDITOR dort, s. `editor-root.tsx`-Kommentar zu
   *  `frontmatterRawRef` — das Formular zeigt den zuletzt bekannten Stand
   *  weiterhin an, aber nur lesend, damit keine zwei gleichzeitig aktiven
   *  Schreibpfade auf denselben Frontmatter-Block divergieren können) UND
   *  während eines fremden, noch nicht übernommenen Soft-Locks (Muster
   *  `WysiwygEditor`/`RawEditor`s `editable`-Prop). */
  editable: boolean
}

const CHEVRON_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true">
    <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

function asArray(value: MetadataFormValue | undefined): string[] {
  return Array.isArray(value) ? value : []
}

function asString(value: MetadataFormValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

/** Ein `text`/`user`-Feld — einfaches kontrolliertes `<input>`. */
function TextFieldWidget({
  field,
  value,
  editable,
  onChange,
}: {
  field: MetadataField
  value: string
  editable: boolean
  onChange: (value: string) => void
}) {
  return (
    <input
      type="text"
      className="input"
      id={`mf-${field.key}`}
      value={value}
      disabled={!editable}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

/** `pattern`-Feld — wie `TextFieldWidget`, zusätzlich Live-Validierung gegen
 *  `field.pattern` (Fehlerzustand + `patternHint`, s. `lib/metadata-form.ts#isPatternValid`). */
function PatternFieldWidget({
  field,
  value,
  editable,
  onChange,
}: {
  field: PatternField
  value: string
  editable: boolean
  onChange: (value: string) => void
}) {
  const { t } = useT()
  const valid = isPatternValid(field, value)
  return (
    <>
      {/* Der Fehlerzustand hängt allein an `aria-invalid`. Bis Teilschritt H2
          stand daneben die Klasse `mf-invalid`, die dasselbe aussagte und im
          Markup von Hand mit dem Attribut synchron gehalten werden musste;
          `styles/41-eingabe.css` liest jetzt das Attribut. */}
      <input
        type="text"
        className="input"
        id={`mf-${field.key}`}
        value={value}
        disabled={!editable}
        aria-invalid={!valid}
        onChange={(event) => onChange(event.target.value)}
      />
      {!valid ? (
        <p className="hint mf-error">
          {field.patternHint ?? t('editor.metadataPanel.invalidPattern', { pattern: field.pattern })}
        </p>
      ) : field.patternHint ? (
        <p className="hint">{field.patternHint}</p>
      ) : null}
    </>
  )
}

/** `enum`-Feld — `<select>` aus `field.options`, plus eine leere Option für
 *  „keine Auswahl" (ein Pflichtfeld ohne Auswahl bleibt sichtbar leer statt
 *  stillschweigend die erste Option vorauszuwählen — s. Spec „leere
 *  Pflichtfelder sichtbar"). */
function EnumFieldWidget({
  field,
  value,
  editable,
  onChange,
}: {
  field: EnumField
  value: string
  editable: boolean
  onChange: (value: string) => void
}) {
  const { t } = useT()
  return (
    <select
      className="input"
      id={`mf-${field.key}`}
      value={value}
      disabled={!editable}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{t('editor.metadataPanel.noSelection')}</option>
      {field.options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  )
}

/** `multi`-Feld — mit `field.options`: Chips zum An-/Abwählen (Klick togglet
 *  Mitgliedschaft, Muster Tag-Auswahl). Ohne `options`: freie Chip-Eingabe
 *  (Komma/Enter fügt hinzu, Backspace bei leerem Eingabefeld entfernt den
 *  letzten Chip, `×`-Button entfernt gezielt — Muster wie gängige
 *  Tag-Eingaben, s. Task-Vorgabe „Muster wie Wikilink-/Tag-Eingaben"). */
function MultiFieldWidget({
  field,
  value,
  editable,
  onChange,
}: {
  field: MultiField
  value: string[]
  editable: boolean
  onChange: (value: string[]) => void
}) {
  const { t } = useT()
  const [draft, setDraft] = useState('')

  if (field.options) {
    return (
      <div className="mf-chip-toggle" role="group" aria-label={field.label}>
        {field.options.map((option) => {
          const active = value.includes(option)
          return (
            <button
              key={option}
              type="button"
              className={active ? 'tag mf-chip-on' : 'tag'}
              disabled={!editable}
              aria-pressed={active}
              onClick={() => onChange(active ? value.filter((v) => v !== option) : [...value, option])}
            >
              {option}
            </button>
          )
        })}
      </div>
    )
  }

  function commitDraft() {
    const trimmed = draft.trim()
    setDraft('')
    if (trimmed.length === 0 || value.includes(trimmed)) return
    onChange([...value, trimmed])
  }

  return (
    <div className="mf-chips">
      {value.map((chip) => (
        <span className="tag mf-chip" key={chip}>
          {chip}
          {editable ? (
            <button
              type="button"
              className="btn quiet mf-chip-remove"
              aria-label={t('editor.metadataPanel.removeChip', { chip })}
              onClick={() => onChange(value.filter((v) => v !== chip))}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
      <input
        type="text"
        className="mf-chip-input"
        id={`mf-${field.key}`}
        placeholder={t('editor.metadataPanel.addChipPlaceholder')}
        value={draft}
        disabled={!editable}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault()
            commitDraft()
          } else if (event.key === 'Backspace' && draft.length === 0 && value.length > 0) {
            onChange(value.slice(0, -1))
          }
        }}
        onBlur={commitDraft}
      />
    </div>
  )
}

/** `date`-Feld — natives `<input type="date">`. Ein Rohwert, der nicht dem
 *  `YYYY-MM-DD`-Format entspricht (z. B. ein voller ISO-Zeitstempel), lässt
 *  den Browser das Feld einfach leer darstellen, bis der Nutzer selbst ein
 *  Datum wählt — kein Absturz, kein Datenverlust (der Rohwert im Formular-
 *  Zustand bleibt unverändert, bis `onChange` feuert). */
function DateFieldWidget({
  field,
  value,
  editable,
  onChange,
}: {
  field: MetadataField
  value: string
  editable: boolean
  onChange: (value: string) => void
}) {
  return (
    <input
      type="date"
      className="input"
      id={`mf-${field.key}`}
      value={value}
      disabled={!editable}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

/** Read-only-Zeile für `'auto'`-Felder (`last_author`/`last_updated`) — die
 *  automatische Ableitung aus Git ist M3b (s. `schema.ts`), M3 zeigt nur den
 *  bereits im Frontmatter stehenden Rohwert an, ohne ihn editierbar zu machen. */
function AutoFieldRow({ field, rawValue }: { field: MetadataField; rawValue: unknown }) {
  const { t } = useT()
  const display = rawValue === null || rawValue === undefined || String(rawValue).trim().length === 0
    ? '—'
    : String(rawValue)
  return (
    <div className="mf-field mf-auto">
      <label htmlFor={`mf-${field.key}`}>{field.label}</label>
      <p className="mf-auto-value" id={`mf-${field.key}`}>
        {display}
      </p>
      <p className="hint">{t('editor.metadataPanel.autoHint')}</p>
    </div>
  )
}

/**
 * Auf-/zuklappbares „Metadaten"-Panel im Editor (Metadaten-Feature M3) —
 * Muster/CSS an `findings-panel.tsx` (Trigger + Popover-artiger Aufbau,
 * hier als eigener flacher Bereich statt Popover, weil die Formularfelder
 * mehr Platz brauchen als eine Befundliste) und `rail.tsx`s `.rp`
 * (dieselbe Eyebrow-Optik wie die Leseansicht-Metadaten). `.card` trug dieser
 * Knoten bis Teilschritt H2 mit — und nahm die Karte in `62-editor.css`
 * Zeile für Zeile wieder zurück (Bestandsaufnahme §2.4, eine der sechs
 * Selbstaufhebungen). Die Klasse ist deshalb entfallen, statt die Basis zu
 * überschreiben; die Sektion hat ohnehin vollständig eigene Regeln. Reine
 * Anzeige-/Eingabe-Komponente: die gesamte Zustands-/Schreiblogik
 * (Formular-Werte halten, `setFrontmatterMetadata` aufrufen, `frontmatterRawRef`
 * aktualisieren, Autosave anstoßen) lebt in `editor-root.tsx` — dieselbe
 * Aufteilung wie bei `ModeSwitch`/`FindingsPanel`.
 *
 * Kein Schema oder ein Schema ohne Felder → rendert `null` (kein Formular,
 * keine Regression für Seiten ohne Metadaten-Feature, Spec „Kein Bruch").
 */
export function MetadataPanel({ schema, values, autoValues, onFieldChange, open, onOpenChange, editable }: MetadataPanelProps) {
  const { t } = useT()
  if (!schema || schema.fields.length === 0) return null

  const missingCount = schema.fields.filter(
    (field) => field.type !== 'auto' && isFieldMissing(field, values[field.key] ?? (field.type === 'multi' ? [] : '')),
  ).length

  return (
    <section className="rp metadata-panel">
      <button
        type="button"
        className="btn quiet metadata-panel-toggle"
        aria-expanded={open}
        aria-controls="metadata-panel-body"
        onClick={() => onOpenChange(!open)}
      >
        <h4>{t('editor.metadataPanel.heading')}</h4>
        {missingCount > 0 ? (
          <span className="chip review">
            {t('editor.metadataPanel.missingBadge', { count: missingCount })}
          </span>
        ) : null}
        <span className="grow" />
        {CHEVRON_ICON}
      </button>
      {open ? (
        <div className="metadata-panel-body" id="metadata-panel-body">
          {!editable ? <p className="hint">{t('editor.metadataPanel.readOnlyHint')}</p> : null}
          {schema.fields.map((field) => {
            if (field.type === 'auto') {
              return <AutoFieldRow key={field.key} field={field} rawValue={autoValues[field.key]} />
            }

            const missing = isFieldMissing(field, values[field.key] ?? (field.type === 'multi' ? [] : ''))

            return (
              <div className="mf-field" key={field.key}>
                <label htmlFor={`mf-${field.key}`}>
                  {field.label}
                  {field.required ? <span className="mf-required" aria-hidden="true"> *</span> : null}
                </label>
                {field.type === 'text' || field.type === 'user' ? (
                  <TextFieldWidget
                    field={field}
                    value={asString(values[field.key])}
                    editable={editable}
                    onChange={(value) => onFieldChange(field.key, value)}
                  />
                ) : field.type === 'pattern' ? (
                  <PatternFieldWidget
                    field={field}
                    value={asString(values[field.key])}
                    editable={editable}
                    onChange={(value) => onFieldChange(field.key, value)}
                  />
                ) : field.type === 'enum' ? (
                  <EnumFieldWidget
                    field={field}
                    value={asString(values[field.key])}
                    editable={editable}
                    onChange={(value) => onFieldChange(field.key, value)}
                  />
                ) : field.type === 'date' ? (
                  <DateFieldWidget
                    field={field}
                    value={asString(values[field.key])}
                    editable={editable}
                    onChange={(value) => onFieldChange(field.key, value)}
                  />
                ) : field.type === 'multi' ? (
                  <MultiFieldWidget
                    field={field}
                    value={asArray(values[field.key])}
                    editable={editable}
                    onChange={(value) => onFieldChange(field.key, value)}
                  />
                ) : null}
                {missing ? <p className="hint mf-required-hint">{t('editor.metadataPanel.requiredHint')}</p> : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
