export interface TemplateVars { titel: string; autor: string; datum: string }

/** Ersetzt die drei Spec-Platzhalter (Spec §6). Callback-Form von replace,
 *  damit `$&`/`$1` in Nutzerdaten literal bleiben. Unbekannte Platzhalter
 *  bleiben unverändert stehen — Templates sind Nutzerinhalt, kein Schema. */
export function renderTemplate(body: string, vars: TemplateVars): string {
  return body.replace(/\{\{(titel|autor|datum)\}\}/g, (_m, key: 'titel' | 'autor' | 'datum') => vars[key])
}

/** Heutiges Datum TT.MM.JJJJ — deutsche UI, deterministisch testbar via `now`. */
export function templateDatum(now: Date = new Date()): string {
  const dd = String(now.getDate()).padStart(2, '0')
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${now.getFullYear()}`
}
