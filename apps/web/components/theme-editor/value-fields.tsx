'use client'

import type { TokenRange } from '@f451/design-tokens'
import { useT } from '../../lib/i18n/provider'
import { fieldKindFor, type ValueMode } from '../../lib/theme-editor'
import { joinLength, pickerValue, splitLength } from '../../lib/theme-editor-view'

export interface FieldProps {
  token: string
  mode: ValueMode
  value: string
  /** set after a failed check on blur — red field, the value stays */
  invalid: boolean
  readOnly: boolean
  onChange: (value: string) => void
  onBlur: () => void
}

export function fieldId(token: string, mode: ValueMode): string {
  return `te-${token.replace(/^--/, '')}-${mode}`
}

function useModeName(mode: ValueMode): string | null {
  const { t } = useT()
  if (mode === 'light') return t('settings.appearance.modeLight')
  if (mode === 'dark') return t('settings.appearance.modeDark')
  return null
}

function useValueLabel(token: string, mode: ValueMode): string {
  const { t } = useT()
  const modeName = useModeName(mode)
  return modeName
    ? t('settings.appearance.valueLabelMode', { token, mode: modeName })
    : t('settings.appearance.valueLabel', { token })
}

/** Free text — font stacks, easings, durations, shadows, text sizes, unsplittable lengths. */
export function TextField({ token, mode, value, invalid, readOnly, onChange, onBlur }: FieldProps) {
  const label = useValueLabel(token, mode)
  return (
    <input
      id={fieldId(token, mode)}
      className="input te-text"
      type="text"
      value={value}
      aria-label={label}
      aria-invalid={invalid || undefined}
      readOnly={readOnly}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
    />
  )
}

/** A colour: picker (only for `#rrggbb`) plus the text field, which edits every notation. */
export function ColorField(props: FieldProps) {
  const { t } = useT()
  const modeName = useModeName(props.mode) ?? ''
  const hex = pickerValue(props.value)
  return (
    <div className="te-color">
      {hex ? (
        <input
          className="te-picker"
          type="color"
          value={hex}
          disabled={props.readOnly}
          aria-label={t('settings.appearance.colorPickerLabel', { token: props.token, mode: modeName })}
          onChange={(event) => props.onChange(event.target.value)}
          onBlur={props.onBlur}
        />
      ) : null}
      <TextField {...props} />
    </div>
  )
}

/** The computed colour of a derived row, drawn by attribute (no inline style). */
export function Swatch({ color }: { color: string }) {
  return (
    <svg className="te-swatch" viewBox="0 0 1 1" aria-hidden="true" focusable="false">
      <rect width="1" height="1" fill={color} />
    </svg>
  )
}

/** One structure value, typed by the catalog range (`fieldKindFor`). */
export function StructureField({ range, ...props }: FieldProps & { range: TokenRange | undefined }) {
  const { t } = useT()
  const { token, mode, value, invalid, readOnly, onChange, onBlur } = props
  const label = useValueLabel(token, mode)
  const kind = fieldKindFor(range)

  if (kind === 'number' && range?.kind === 'number') {
    return (
      <input
        id={fieldId(token, mode)}
        className="input te-number"
        type="number"
        min={range.min}
        max={range.max}
        step={range.integer ? 1 : 'any'}
        value={value}
        aria-label={label}
        aria-invalid={invalid || undefined}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
    )
  }

  if (kind === 'length' && range?.kind === 'length') {
    const parts = splitLength(value, range.units)
    if (!parts) return <TextField {...props} />
    return (
      <div className="te-length">
        <input
          id={fieldId(token, mode)}
          className="input te-number"
          type="number"
          min={range.min}
          max={range.max}
          step="any"
          value={parts.amount}
          aria-label={label}
          aria-invalid={invalid || undefined}
          readOnly={readOnly}
          onChange={(event) => onChange(joinLength(event.target.value, parts.unit))}
          onBlur={onBlur}
        />
        <div className="selectwrap te-unit">
          <select
            className="select"
            value={parts.unit}
            aria-label={t('settings.appearance.unitLabel', { token })}
            disabled={readOnly || range.units.length < 2}
            onChange={(event) => onChange(joinLength(parts.amount, event.target.value))}
            onBlur={onBlur}
          >
            {range.units.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <span className="caret" aria-hidden="true">
            ▾
          </span>
        </div>
      </div>
    )
  }

  if (kind === 'choice' && range?.kind === 'choice') {
    // A value outside the list (e.g. an invalid one from the file) stays visible as its own entry.
    const options = range.values.includes(value) ? range.values : [value, ...range.values]
    return (
      <div className="selectwrap">
        <select
          id={fieldId(token, mode)}
          className="select"
          value={value}
          aria-label={label}
          aria-invalid={invalid || undefined}
          disabled={readOnly}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        >
          {options.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </div>
    )
  }

  return <TextField {...props} />
}
