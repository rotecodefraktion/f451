// --- Footnote label -> identifier (mdast normalisation) -----------------------------
//
// mdast-util-gfm-footnote derives `identifier` from the label as written via
// micromark's normalizeIdentifier (collapse whitespace runs, trim, case-fold) followed
// by a final lowercase. This mirrors that rule so an editor-created reference, which
// only carries a label, gets the identifier the parser would assign to the same text.
// The upper/lower round trip is micromark's case-folding trick (e.g. `ẞ` -> `ss`);
// it is a no-op for ASCII labels.

export function footnoteIdentifier(label: string): string {
  return label
    .replace(/[\t\n\r ]+/g, ' ')
    .trim()
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
}
