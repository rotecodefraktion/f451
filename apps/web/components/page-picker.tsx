'use client'

/**
 * Page picker (#175): a native select over the space tree, indented by depth.
 * With `emptyLabel` the first option (value '') stands for "no page" (space
 * root, whole space); without it a page is required and the picker selects
 * the first page as soon as the value is not one of its options.
 */
import { useEffect, useMemo } from 'react'
import { flattenTree } from '../lib/page-picker'
import type { TreeNodeData } from './tree'

/** Indentation per depth level; non-breaking so the browser keeps it. */
const INDENT = '   '

export interface PagePickerProps {
  id: string
  tree: TreeNodeData[]
  value: string
  onChange: (id: string) => void
  emptyLabel?: string
}

export function PagePicker({ id, tree, value, onChange, emptyLabel }: PagePickerProps) {
  const options = useMemo(() => flattenTree(tree), [tree])
  const required = emptyLabel === undefined
  const first = options[0]?.id
  const known = options.some((o) => o.id === value)

  useEffect(() => {
    if (required && !known && first !== undefined) onChange(first)
  }, [required, known, first, onChange])

  return (
    <div className="selectwrap">
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {!required && <option value="">{emptyLabel}</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {`${INDENT.repeat(o.depth)}${o.title}`}
          </option>
        ))}
      </select>
      <span className="caret" aria-hidden="true">
        ▾
      </span>
    </div>
  )
}
