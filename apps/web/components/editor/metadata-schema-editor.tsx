'use client'

import { useMemo, useState } from 'react'
import { AUTO_FIELD_SOURCES, METADATA_FIELD_TYPES, parseMetadataSchemaFromValue } from '@f451/markdown'
import type { AutoFieldSource, MetadataFieldType, MetadataSchema } from '@f451/markdown'
import { saveMetadataSchema } from '../../lib/editor/client-api'
import { useT } from '../../lib/i18n/provider'
import {
  addField,
  changeFieldType,
  draftFieldsToPayload,
  moveFieldDown,
  moveFieldUp,
  removeFieldAt,
  schemaToDraftFields,
  type DraftMetadataField,
} from '../../lib/metadata-schema-form'

export interface MetadataSchemaEditorProps {
  space: string
  /** Ausgangsstand (`GET /api/spaces/:space/metadata-schema`, server-seitig
   *  von `schema/page.tsx` geladen) — ein Space ohne `_meta/schema.yaml`
   *  liefert `{fields: []}` (fail-soft, s. `apps/api/src/spaces/metadata-schema.ts`),
   *  der Editor startet dann einfach leer statt mit einem Fehlerzustand. */
  initialSchema: MetadataSchema
}

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'success' }
  | { status: 'error'; message: string; errors: string[] }

/**
 * Ein-Feld-Editor innerhalb der Feld-Liste (Metadaten-Feature M4). Reine
 * Anzeige-/Eingabe-Komponente — der gesamte State lebt in
 * {@link MetadataSchemaEditor}, Muster `MetadataPanel`/`editor-root.tsx`
 * (Formularfelder ändern per `onChange`-Callback den Zustand des Elternteils,
 * statt selbst eine Kopie zu halten).
 */
function FieldEditor({
  field,
  index,
  total,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  field: DraftMetadataField
  index: number
  total: number
  onChange: (next: DraftMetadataField) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
}) {
  const { t } = useT()
  return (
    <li className="card schema-field">
      <div className="schema-field-head">
        <span className="schema-field-index">{t('schema.fieldNumber', { n: index + 1 })}</span>
        <div className="schema-field-move">
          <button type="button" className="btn small" onClick={onMoveUp} disabled={index === 0} aria-label={t('schema.moveUp')}>
            ↑
          </button>
          <button
            type="button"
            className="btn small"
            onClick={onMoveDown}
            disabled={index === total - 1}
            aria-label={t('schema.moveDown')}
          >
            ↓
          </button>
        </div>
        <span className="grow" />
        <button type="button" className="btn small schema-field-remove" onClick={onRemove}>
          {t('schema.remove')}
        </button>
      </div>

      <div className="schema-field-grid">
        <label>
          {t('schema.key')}
          <input
            type="text"
            className="mf-input"
            value={field.key}
            autoComplete="off"
            onChange={(event) => onChange({ ...field, key: event.target.value })}
          />
        </label>
        <label>
          {t('schema.displayName')}
          <input
            type="text"
            className="mf-input"
            value={field.label}
            autoComplete="off"
            onChange={(event) => onChange({ ...field, label: event.target.value })}
          />
        </label>
        <label>
          {t('schema.type')}
          <select
            className="mf-input"
            value={field.type}
            onChange={(event) => onChange(changeFieldType(field, event.target.value as MetadataFieldType))}
          >
            {METADATA_FIELD_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`schema.typeLabels.${type}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="schema-field-required">
          <input
            type="checkbox"
            checked={field.required}
            onChange={(event) => onChange({ ...field, required: event.target.checked })}
          />
          {t('schema.required')}
        </label>
      </div>

      {field.type === 'pattern' ? (
        <div className="schema-field-grid">
          <label>
            {t('schema.pattern')}
            <input
              type="text"
              className="mf-input"
              value={field.pattern}
              autoComplete="off"
              onChange={(event) => onChange({ ...field, pattern: event.target.value })}
            />
          </label>
          <label>
            {t('schema.patternHint')}
            <input
              type="text"
              className="mf-input"
              value={field.patternHint}
              autoComplete="off"
              onChange={(event) => onChange({ ...field, patternHint: event.target.value })}
            />
          </label>
        </div>
      ) : null}

      {field.type === 'enum' || field.type === 'multi' ? (
        <label className="schema-field-options">
          {field.type === 'enum' ? t('schema.optionsEnum') : t('schema.optionsMulti')}
          <textarea
            className="mf-input schema-field-textarea"
            value={field.optionsText}
            rows={3}
            onChange={(event) => onChange({ ...field, optionsText: event.target.value })}
          />
        </label>
      ) : null}

      {field.type === 'user' ? (
        <label className="schema-field-required">
          <input
            type="checkbox"
            checked={field.fillOnRelease === 'actor'}
            onChange={(event) => onChange({ ...field, fillOnRelease: event.target.checked ? 'actor' : '' })}
          />
          {t('schema.fillOnReleaseUser')}
        </label>
      ) : null}

      {field.type === 'date' ? (
        <label className="schema-field-required">
          <input
            type="checkbox"
            checked={field.fillOnRelease === 'date'}
            onChange={(event) => onChange({ ...field, fillOnRelease: event.target.checked ? 'date' : '' })}
          />
          {t('schema.fillOnReleaseDate')}
        </label>
      ) : null}

      {field.type === 'auto' ? (
        <label>
          {t('schema.source')}
          <select
            className="mf-input"
            value={field.source}
            onChange={(event) => onChange({ ...field, source: event.target.value as AutoFieldSource })}
          >
            <option value="">{t('schema.sourcePlaceholder')}</option>
            {AUTO_FIELD_SOURCES.map((source) => (
              <option key={source} value={source}>
                {t(`schema.sourceLabels.${source}`)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </li>
  )
}

/**
 * Metadaten-Schema-Editor (Metadaten-Feature M4) — pflegt `_meta/schema.yaml`
 * eines Space über `PUT /api/spaces/:space/metadata-schema`. Erster-Run-
 * Entscheidung (Muster `new-page-button.tsx`, dortiger Kommentar): die Seite
 * ist IMMER voll editierbar, unabhängig vom Schreibrecht — ein Leser bekommt
 * beim Speichern die 403-Meldung im Formular statt eines vorab
 * ausgeblendeten/read-only Editors (dieselbe Abwägung: eine zweite,
 * clientseitige Gate-Kette nur für die Anzeige lohnt sich nicht, der
 * Server-Gate ist die eigentliche Durchsetzung).
 *
 * Lokale Vorab-Validierung über `parseMetadataSchemaFromValue` (dieselbe
 * Funktion, die die Schreib-Route serverseitig aufruft, s.
 * `apps/api/src/routes/metadata-schema.ts`) — EIN Regelwerk, kein
 * dupliziertes zweites clientseitiges. Ein lokal ungültiges Schema wird ohne
 * Server-Roundtrip mit den Feldfehlern angezeigt.
 */
export function MetadataSchemaEditor({ space, initialSchema }: MetadataSchemaEditorProps) {
  const { t } = useT()
  const [fields, setFields] = useState<DraftMetadataField[]>(() => schemaToDraftFields(initialSchema))
  // `versioning` hat bewusst KEIN Bedienelement im Editor (s. Modulkommentar
  // `lib/metadata-schema-form.ts`) — dieser State existiert nur, damit der
  // beim Laden gesehene Wert unverändert durch jeden Speichervorgang
  // durchgereicht wird, statt beim Bau des PUT-Payloads (Fehlen jeder
  // UI-Steuerung) stillschweigend auf `false` zurückzufallen.
  const [versioning, setVersioning] = useState(initialSchema.versioning)
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' })

  // Live-Vorschau der Validierung (Muster `MetadataPanel`s `missingCount`) —
  // rein informativ, blockiert die Eingabe nicht; erst „Speichern" prüft
  // verbindlich (derselbe Aufruf, s. Funktionskommentar oben).
  const localErrors = useMemo(
    () => parseMetadataSchemaFromValue(draftFieldsToPayload(fields, versioning)).errors,
    [fields, versioning],
  )

  function updateField(index: number, next: DraftMetadataField) {
    setFields((current) => current.map((f, i) => (i === index ? next : f)))
    setSaveState({ status: 'idle' })
  }

  function onAddField() {
    setFields((current) => addField(current))
    setSaveState({ status: 'idle' })
  }

  async function onSave() {
    setSaveState({ status: 'saving' })
    const payload = draftFieldsToPayload(fields, versioning)
    const { schema, errors } = parseMetadataSchemaFromValue(payload)
    if (errors.length > 0) {
      setSaveState({ status: 'error', message: t('schema.invalid'), errors })
      return
    }

    try {
      const result = await saveMetadataSchema(space, schema)
      if (result.ok) {
        setFields(schemaToDraftFields(result.schema))
        // Serverantwort ist die neue Quelle der Wahrheit (Muster `setFields`
        // direkt darüber) — hält `versioning` synchron, falls sich der
        // Server-Stand je vom lokal gehaltenen Wert unterscheiden sollte.
        setVersioning(result.schema.versioning)
        setSaveState({ status: 'success' })
        return
      }
      if (result.status === 400) {
        setSaveState({ status: 'error', message: result.error, errors: result.errors })
        return
      }
      setSaveState({ status: 'error', message: result.error, errors: [] })
    } catch {
      setSaveState({
        status: 'error',
        message: t('schema.saveFailed'),
        errors: [],
      })
    }
  }

  return (
    <div className="schema-editor">
      {/* Leerzustand-Baustein (43-flaeche.css) statt einer grauen Textzeile. */}
      {fields.length === 0 ? (
        <div className="empty">
          <p>{t('schema.empty')}</p>
        </div>
      ) : null}

      <ul className="schema-field-list">
        {fields.map((field, index) => (
          <FieldEditor
            // Index als Key ist hier bewusst in Ordnung: die Liste hat keine
            // stabile fremde Id (der `key`-Wert selbst ist gerade das
            // editierte Feld, oft anfangs leer/doppelt) — Umsortieren über
            // `moveFieldUp`/`moveFieldDown` ersetzt exakt zwei Einträge, kein
            // Reconciliation-Problem.
            key={index}
            field={field}
            index={index}
            total={fields.length}
            onChange={(next) => updateField(index, next)}
            onMoveUp={() => {
              setFields((current) => moveFieldUp(current, index))
              setSaveState({ status: 'idle' })
            }}
            onMoveDown={() => {
              setFields((current) => moveFieldDown(current, index))
              setSaveState({ status: 'idle' })
            }}
            onRemove={() => {
              setFields((current) => removeFieldAt(current, index))
              setSaveState({ status: 'idle' })
            }}
          />
        ))}
      </ul>

      <div className="schema-editor-actions">
        <button type="button" className="btn" onClick={onAddField}>
          {t('schema.addField')}
        </button>
        <span className="grow" />
        <button type="button" className="btn primary" onClick={onSave} disabled={saveState.status === 'saving'}>
          {saveState.status === 'saving' ? t('schema.saving') : t('schema.save')}
        </button>
      </div>

      {/* Hinweisblock-Baustein (43-flaeche.css). `.tool-status` liefert nur
          den Außenabstand, den `.callout` bewusst nicht mitbringt; die
          Randabstände der Kinder gehören dem Kasten, deshalb brauchen die
          Absätze darin keinen eigenen Nullrand mehr. */}
      {saveState.status === 'success' ? (
        <p className="callout ok tool-status" role="status">
          {t('schema.saved')}
        </p>
      ) : saveState.status === 'error' ? (
        <div className="callout error tool-status" role="alert">
          <p>{saveState.message}</p>
          {saveState.errors.length > 0 ? (
            <ul className="notice-list">
              {saveState.errors.map((error, i) => (
                <li key={i}>{error}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : localErrors.length > 0 ? (
        <div className="callout tool-status">
          <p>{t('schema.notSavableYet')}</p>
          <ul className="notice-list">
            {localErrors.map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
