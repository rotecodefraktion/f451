'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { checkEditorSupport, type EditorSupportReport, type SupportFinding } from '@f451/editor'
import { joinFrontmatter, setFrontmatterMetadata, splitFrontmatter } from '@f451/markdown'
import type { MetadataSchema } from '@f451/markdown'
import {
  ClientApiError,
  createDraft,
  deletePage,
  discardDraft,
  heartbeatLock,
  releaseLock,
  requestReview,
  saveAsTemplate,
  saveDraft,
  updateDraft,
  type DraftInfo,
  type LockInfo,
  type SaveAsTemplateResult,
} from '../../lib/editor/client-api'
import { createAutosave, type Autosave } from '../../lib/editor/autosave'
import { clearOfflineDraft, readOfflineDraft, writeOfflineDraft } from '../../lib/editor/offline-buffer'
import { evaluateOfflineRecovery } from '../../lib/editor/offline-recovery'
import { archivedFromFrontmatter, titleFromFrontmatter } from '../../lib/editor/frontmatter-fields'
import { classifySaveFailure } from '../../lib/editor/save-failure'
import { frontmatterLineOffset, offsetFindingLines } from '../../lib/editor/frontmatter-offset'
import { evaluateModeSwitch, type EditorMode } from '../../lib/editor/mode-switch-core'
import { describeResetFailure } from '../../lib/editor/reset-recovery'
import {
  deriveMetadataFormValues,
  rawMetadataFromFrontmatter,
  toMetadataValues,
  type MetadataFormValue,
  type MetadataFormValues,
} from '../../lib/metadata-form'
import { apiPageRawPath, wikiPageHref, wikiPageReviewHref, wikiSpaceHref } from '../../lib/urls'
import { useT } from '../../lib/i18n/provider'
import type { T } from '../../lib/i18n/types'
import { ConflictDialog } from './conflict-dialog'
import { FindingsPanel } from './findings-panel'
import { LockBanner } from './lock-banner'
import { MetadataPanel } from './metadata-panel'
import { ModeSwitch } from './mode-switch'
import { OfflineRecoveryDialog } from './offline-recovery-dialog'
import { RawEditor, type RawEditorHandle } from './raw-editor'
import { ResetRecoveryDialog } from './reset-recovery-dialog'
import { SaveTemplateDialog } from './save-template-dialog'
import { StatusBar } from './status-bar'
import { TitleField } from './title-field'
import { WysiwygEditor, type WysiwygEditorHandle } from './wysiwyg-editor'

/** Kurzer, menschenlesbarer Grund für den WYSIWYG-Tab-Tooltip, wenn der
 *  letzte bekannte Stand (Startmodus ODER letzter verweigerter Klick) den
 *  Wechsel verweigern würde. Reine Textformatierung (keine Entscheidung —
 *  die liegt in `evaluateModeSwitch`), deshalb hier lokal statt in
 *  `lib/editor/mode-switch-core.ts`. */
function describeBlockReason(findings: SupportFinding[], t: T): string {
  const unsupported = findings.filter((finding) => finding.kind === 'unsupported')
  if (unsupported.length === 0) return t('editor.blockReason.generic')
  if (unsupported.length === 1) return t('editor.blockReason.single', { message: unsupported[0].message })
  return t('editor.blockReason.multiple', { count: unsupported.length })
}

export interface EditorRootProps {
  pageId: string
  space: string
  title: string
  /** Metadaten-Schema des Space (`GET /api/spaces/:space/metadata-schema`,
   *  server-seitig von `edit/page.tsx` geladen — Muster M2/`rail.tsx`, hier
   *  als Prop statt eines eigenen Client-Fetches, weil `edit/page.tsx`
   *  ohnehin bereits eine Server Component ist). `null`, wenn der
   *  Schema-Request fehlgeschlagen ist oder kein Schema konfiguriert ist —
   *  Fail-Soft wie überall sonst bei diesem Feature: `MetadataPanel` rendert
   *  dann einfach nichts (kein Formular, keine Regression). */
  metadataSchema: MetadataSchema | null
}

/** Startmodus-Entscheidung: `canEdit:false` (nicht abbildbare Syntax, z. B.
 *  rohes HTML/Fußnoten) erzwingt den Roh-Text-Modus, sonst startet der
 *  WYSIWYG-Modus (`@f451/editor` README, Abschnitt „Validierungs-Vertrag"). */
type StartMode = 'wysiwyg' | 'raw'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; retryable: boolean; message: string }
  | {
      status: 'ready'
      draft: DraftInfo
      startMode: StartMode
      support: EditorSupportReport
      /** Roher Frontmatter-Block (inkl. `---`-Zäune) — der Editor selbst arbeitet
       *  nur auf `body`, `editor-root` fügt beides über `joinFrontmatter` beim
       *  Speichern wieder zusammen (s. `EditorSession`). */
      frontmatterRaw: string
      body: string
    }

function startModeOf(support: EditorSupportReport): StartMode {
  return support.canEdit ? 'wysiwyg' : 'raw'
}

const AUTOSAVE_DEBOUNCE_MS = 30_000
/** Heartbeat-Intervall (Brief-Vorgabe) — deutlich unter der serverseitigen
 *  `LOCK_TTL_MS` (2 min, `apps/api/src/drafts/lifecycle.ts`), damit der eigene
 *  Lock nie allein durch Latenz zwischen zwei Heartbeats abläuft. */
const HEARTBEAT_INTERVAL_MS = 45_000

interface ConflictState {
  currentSha: string
  currentContent: string
  /** Genau das Markdown (Frontmatter + Body), das den 409 ausgelöst hat — für
   *  „Meine Fassung behalten" wird ERNEUT dieser Stand gesendet, nicht ein
   *  frisch aus dem (während des modalen Dialogs ohnehin inerten) Editor
   *  gelesener, weil beide identisch sein müssen mit dem, was der Dialog anzeigt. */
  localContent: string
}

interface EditorSessionProps {
  pageId: string
  space: string
  title: string
  metadataSchema: MetadataSchema | null
  draft: DraftInfo
  startMode: StartMode
  /** Der `checkEditorSupport`-Report, der `startMode` bestimmt hat (Task 2) —
   *  seedet Task 6s `findings`/`wysiwygBlockReason`, ohne ihn beim Mount ein
   *  zweites Mal zu berechnen. */
  support: EditorSupportReport
  frontmatterRaw: string
  body: string
  /** „Auf letzte Freigabe zurücksetzen" (Phase 2d Task 6) — lebt in
   *  `EditorRoot`, NICHT hier: `updateDraft({strategy:'take-main'})` liefert
   *  einen komplett neuen Inhalts-/`baseSha`-Stand für DENSELBEN Draft-Branch
   *  (Name ändert sich nicht), ein sauberer Remount wie beim Konflikt-Retry
   *  ist deshalb nur über `EditorRoot`s `LoadState` + einen eigenen
   *  Remount-Zähler möglich (s. dortiger Kommentar). */
  onResetToLastRelease: () => void
  /** Finding 1 (Fix-Runde 1): gesetzt, solange ein fehlgeschlagener Reset
   *  geretteten Inhalt übrig gelassen hat (s. `EditorRoot`-Kommentar zu
   *  `resetRecovery`) — der Dialog selbst UND die Übernahme/das Verwerfen
   *  laufen hier, weil beides die Editor-Refs/den Autosave-State dieser
   *  Session braucht. */
  resetRecovery: { preservedContent: string } | null
  onDismissResetRecovery: () => void
  /** Phase 4b Task 3 (Spec §9, Mount-Recovery) — analog zu `resetRecovery`:
   *  lebt in `EditorRoot` (dort ausgewertet, s. `load()`), weil `evaluateOfflineRecovery`
   *  bereits beim Laden des Server-Drafts läuft, BEVOR diese Session mountet.
   *  `content` ist das VOLLE gepufferte Dokument (Frontmatter + Body, Vertrag
   *  wie `OfflineDraft.content`), `foreignBranch` steuert nur den Zusatzhinweis
   *  im Dialog (s. `evaluateOfflineRecovery`-Kopfkommentar, Regel 4). */
  offlineRecovery: { content: string; savedAt: string; foreignBranch: boolean } | null
  onDismissOfflineRecovery: () => void
}

/**
 * Trägt die gesamte Task-4-Verdrahtung (Autosave, Soft-Lock, Statuszeile,
 * Konflikt-Dialog) für EINEN geladenen Draft-Stand. Als eigene Komponente
 * ausgelagert und über `key={draft.branch}` in `EditorRoot` gemountet (Muster
 * aus Task 3 für `WysiwygEditor` übernommen): ein erneutes `load()` (z. B. nach
 * einem Fehler-Retry) liefert potenziell einen neuen Branch/`baseSha` — ein
 * sauberer Remount ist einfacher und robuster als jedes Session-State-Feld
 * (Autosave-Instanz, Lock-Status, `baseSha`-Ref …) manuell zurückzusetzen.
 */
function EditorSession({
  pageId,
  space,
  title,
  metadataSchema,
  draft,
  startMode,
  support,
  frontmatterRaw,
  body,
  onResetToLastRelease,
  resetRecovery,
  onDismissResetRecovery,
  offlineRecovery,
  onDismissOfflineRecovery,
}: EditorSessionProps) {
  const { t } = useT()
  const router = useRouter()
  const wysiwygRef = useRef<WysiwygEditorHandle>(null)
  const rawEditorRef = useRef<RawEditorHandle>(null)
  const autosaveRef = useRef<Autosave>(createAutosave({ debounceMs: AUTOSAVE_DEBOUNCE_MS }))
  const baseShaRef = useRef(draft.baseSha)
  const frontmatterRawRef = useRef(frontmatterRaw)

  // Erzwingt einen Re-Render, wenn sich NUR der interne Zustand von `autosaveRef`
  // geändert hat (die Autosave-Instanz selbst ist bewusst kein React-State, s.
  // `lib/editor/autosave.ts` — reines, node-testbares Modul ohne React-Bezug).
  // `tick` selbst wird unten im Timer-Effekt als Dependency gebraucht (NICHT nur
  // verworfen) — sonst würde der Timer-Effekt nach dem ersten Render nie wieder
  // laufen, weil `triggerFlush` eine über Renders hinweg stabile Referenz ist.
  const [tick, setTick] = useState(0)
  const bumpTick = useCallback(() => setTick((t) => t + 1), [])

  const [savedAt, setSavedAt] = useState<string | null>(null)
  // Error of the last discard attempt, shown above the status bar (#22).
  const [discardError, setDiscardError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  // Task 6 (Phase 3c): „Als Vorlage speichern …" — der Dialog selbst trägt
  // seinen Formular-/Ergebnis-State (Muster `SaveTemplateDialog`), hier lebt
  // nur die Sichtbarkeit (Menüpunkt in der Statuszeile öffnet, Dialog meldet
  // jedes Schließen über `onClose` zurück).
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false)
  // Task 6: „Review anfordern" — verhindert einen Doppel-Request bei
  // Mehrfachklick, WÄHREND die Anfrage läuft (der Button ist zusätzlich
  // deaktiviert, s. `requestReviewDisabled` unten).
  const [requestingReview, setRequestingReview] = useState(false)
  const [mountBody, setMountBody] = useState(body)
  // Roh-Modus-Gegenstück zu `mountBody` — das VOLLE Dokument (inkl.
  // Frontmatter), s. `raw-editor.tsx`-Kopfkommentar: der Roh-Modus ist der
  // einzige Frontmatter-Editor in 2c, `joinFrontmatter`/`splitFrontmatter`
  // laufen deshalb nur beim Moduswechsel, nicht bei jedem Tastenanschlag.
  const [mountRawContent, setMountRawContent] = useState(() => joinFrontmatter(frontmatterRaw, body))
  const [remountKey, setRemountKey] = useState(0)

  // --- Metadaten-Erfass-Formular (Metadaten-Feature M3, metadata-panel.tsx) --
  //
  // `frontmatterRawRef` (s. o.) bleibt die EINZIGE Quelle für den Frontmatter —
  // `metadataFormValues`/`metadataAutoValues` sind nur eine daraus ABGELEITETE
  // Anzeige-/Formular-Sicht (`lib/metadata-form.ts`), keine zweite
  // Wahrheitsquelle. Sie werden deshalb an JEDER Stelle NEU berechnet, an der
  // auch `frontmatterRawRef.current` einen frischen Wert aus einem geparsten
  // Dokument bekommt (Moduswechsel Roh→WYSIWYG, Normalisierung, Konflikt-/
  // Reset-/Offline-Recovery) — Muster identisch zu `mountBody`/`mountRawContent`
  // dort. Formular-Änderungen selbst (`handleMetadataFieldChange` unten) sind
  // die einzige Stelle, die in die ANDERE Richtung schreibt (Formular →
  // `frontmatterRawRef`).
  const [metadataFormValues, setMetadataFormValues] = useState<MetadataFormValues>(() =>
    metadataSchema ? deriveMetadataFormValues(metadataSchema, frontmatterRaw) : {},
  )
  const [metadataAutoValues, setMetadataAutoValues] = useState<Record<string, unknown>>(() =>
    rawMetadataFromFrontmatter(frontmatterRaw),
  )
  const [metadataPanelOpen, setMetadataPanelOpen] = useState(false)

  // --- Titelfeld + Archivieren-Toggle (Feature 2/4) --------------------------
  //
  // Dieselbe Quelle-der-Wahrheit-Regel wie beim Metadaten-Formular oben:
  // `frontmatterRawRef.current` bleibt EINZIGE Quelle, `titleValue`/`archivedValue`
  // sind nur eine daraus abgeleitete Anzeige-/Eingabe-Sicht
  // (`lib/editor/frontmatter-fields.ts`) — neu berechnet an JEDER Stelle, an der
  // auch das Metadaten-Formular resynchronisiert wird (`syncMetadataFromFrontmatter`
  // unten deckt beides ab).
  const [titleValue, setTitleValue] = useState(() => titleFromFrontmatter(frontmatterRaw))
  const [archivedValue, setArchivedValue] = useState(() => archivedFromFrontmatter(frontmatterRaw))

  // --- Task 6: Moduswechsel-Schutz + Validierungs-Anzeige --------------------
  const [mode, setMode] = useState<EditorMode>(startMode)
  // Letzter bekannter `checkEditorSupport`-Report — die einzige Quelle des
  // `findings-panel`, in BEIDEN Modi (WYSIWYG: bei Moduswechsel/Save neu
  // berechnet; Roh: aus dem debounced Lint-Lauf von `raw-editor.tsx`).
  const [findings, setFindings] = useState<SupportFinding[]>(support.findings)
  // Nur gesetzt, solange der letzte bekannte Stand (Startmodus ODER letzter
  // verweigerter Klick) den WYSIWYG-Wechsel verweigern würde — Tab-Tooltip.
  const [wysiwygBlockReason, setWysiwygBlockReason] = useState<string | null>(
    startMode === 'raw' ? describeBlockReason(support.findings, t) : null,
  )
  const [pendingConfirm, setPendingConfirm] = useState<{ findings: SupportFinding[]; canonicalBody: string; rawContent: string } | null>(
    null,
  )
  const [findingsPanelOpen, setFindingsPanelOpen] = useState(false)

  // Soft-Lock: `entryGateActive` startet synchron aus der `createDraft`-Antwort
  // (kein Warten auf den ersten `heartbeatLock`-Roundtrip nötig — verhindert einen
  // kurzen „editierbar"-Flackerer, bevor die erste Heartbeat-Antwort da ist).
  // `lockNotice` deckt BEIDE Brief-Fälle ab: Einstieg (koppelt an `entryGateActive`)
  // UND Verlust im laufenden Betrieb (reine Anzeige, blockiert nichts mehr).
  const [entryGateActive, setEntryGateActive] = useState(() => !!(draft.lock && !draft.lock.mine))
  const [lockNotice, setLockNotice] = useState<{ heldBy: string } | null>(() =>
    draft.lock && !draft.lock.mine ? { heldBy: draft.lock.user } : null,
  )

  const backHref = useMemo(() => wikiPageHref(space, pageId), [space, pageId])

  /** Liest den aktuellen Editor-Inhalt, MODUS-abhängig (Task 6): im WYSIWYG-
   *  Modus über `wysiwygRef.getMarkdownBody()` + `joinFrontmatter` (wie
   *  bisher), im Roh-Modus direkt der CodeMirror-Text (bereits das VOLLE
   *  Dokument, s. `raw-editor.tsx`). EIN Ort für diese Weiche statt
   *  Duplikation über `performSave`/`onUnload` hinweg (beide branchen
   *  identisch). VERTRAG (wysiwyg-editor.tsx): bei `ok:false` NICHT
   *  speichern — der Editor zeigt sein eigenes Fehlerbanner selbst. Derselbe
   *  Vertrag gilt für den Offline-Puffer (Phase 4b Task 2, s. `saveContent`
   *  unten): `ok:false` darf NIE gepuffert werden, ein veralteter/leerer Stand
   *  würde sonst Nutzeränderungen beim Recovery überschreiben. */
  const readCurrentContent = useCallback((): { ok: true; content: string } | { ok: false } => {
    if (mode === 'wysiwyg') {
      const markdown = wysiwygRef.current?.getMarkdownBody()
      if (!markdown || !markdown.ok) return { ok: false }
      return { ok: true, content: joinFrontmatter(frontmatterRawRef.current, markdown.body) }
    }
    const content = rawEditorRef.current?.getContent()
    if (content === undefined) return { ok: false }
    return { ok: true, content }
  }, [mode])

  /** Reine Netzwerk-/Zustands-Seite eines Save-Versuchs — nimmt FERTIGES Markdown
   *  entgegen (kein `getMarkdownBody()`-Aufruf hier), damit „Meine Fassung
   *  behalten" exakt den im Konflikt-Dialog gezeigten Stand erneut senden kann,
   *  ohne den (während des modalen Dialogs ohnehin inerten) Editor erneut zu lesen.
   *  `opts.keepalive` (Review-Fund 1 + 3, Phase 2c Task 4): der `pagehide`/
   *  `beforeunload`-Pfad ruft dies ebenfalls auf statt eines separaten
   *  Fire-and-forget-Fetches — so meldet auch der Keepalive-Save sein Ergebnis
   *  über `onSaveResult` zurück. Überlebt der JS-Kontext den Unload NICHT
   *  wirklich (echtes Tab-Close), verhallt die Rückmeldung wirkungslos; überlebt
   *  er (bfcache-Restore, iOS-Tab-Backgrounding), heilt sich die Autosave-State-
   *  Machine dadurch selbst aus einem sonst dauerhaften `saving`-Zustand — ein
   *  zusätzlicher `pageshow`-Listener ist NICHT nötig: die bfcache-Freeze pausiert
   *  den gesamten JS-Kontext inklusive ausstehender Promise-Callbacks, das `.then`/
   *  `.catch` hier feuert beim Restore einfach nach (verzögert, aber korrekt).
   *
   *  Phase 4b Task 2 (Resilienz, Spec §9): jeder Fehlpfad hier — inklusive des
   *  Keepalive-Pfads, der über diese selbe Funktion läuft — puffert den
   *  AKTUELLEN Editor-Inhalt lokal via `writeOfflineDraft`, BEVOR die
   *  State-Machine informiert wird. Bewusst NICHT das `content`-Argument
   *  (der zum Versand-Zeitpunkt gelesene Stand), sondern ein FRISCHER
   *  `readCurrentContent()`-Aufruf: während der Save unterwegs war, kann der
   *  Nutzer weitergetippt haben (`pendingChangeDuringSave` in autosave.ts) —
   *  nur der frische Stand puffert wirklich alles. Liefert dieser frische
   *  Read `ok:false`, wird NICHT gepuffert (harter Vertrag, s. Docblock oben)
   *  — der zuletzt erfolgreich gepufferte Stand bleibt dabei unangetastet.
   *  Die Fehlerklassifizierung (welcher `SaveOutcome` an die Machine geht)
   *  passiert HIER, nicht in `autosave.ts` (die Machine bekommt nur das
   *  Ergebnis, s. dortiger Modulkommentar): `SessionExpiredError` (401) —
   *  die Umleitung läuft in `client-api.ts` bereits, hier zählt nur noch die
   *  Pufferung („Editor-Inhalt überlebt Re-Login"); `ClientApiError` mit
   *  `status === 0` (Netzwerkfehler, s. `client-api.ts#rawFetch`) oder
   *  `status >= 500` (Provider/Server nicht erreichbar) → `'offline-error'`;
   *  jeder andere Fehler (z. B. 403 „kein Schreibrecht") ist NICHT transient
   *  → weiterhin `'error'`. */
  const saveContent = useCallback(
    async (content: string, baseSha: string, opts?: { keepalive?: boolean }) => {
      try {
        const result = await saveDraft(pageId, { content, baseSha }, opts)
        if (result.ok) {
          baseShaRef.current = result.newSha
          setSavedAt(result.savedAt)
          clearOfflineDraft(pageId)
          autosaveRef.current.onSaveResult('ok', Date.now())
        } else {
          setConflict({
            currentSha: result.conflict.currentSha,
            currentContent: result.conflict.currentContent,
            localContent: content,
          })
          autosaveRef.current.onSaveResult('conflict', Date.now())
        }
      } catch (err) {
        // Fix-Runde 1, Finding 1: `writeOfflineDraft` liefert `false`, wenn der
        // localStorage nicht verfügbar/voll ist (Quota, Safari-Private-Mode —
        // Modulvertrag). Dann ist NICHTS gesichert; ein `offline`-Zustand mit
        // dem Versprechen „Änderungen lokal" wäre eine Lüge (beim Reload weg).
        // Deshalb: nur wenn die Pufferung wirklich gelungen ist, darf der
        // Netz-/5xx-Pfad in den selbstheilenden `offline`-Zustand — sonst
        // (buffered === false ODER nicht lesbarer Inhalt) fällt er auf den
        // sichtbaren `error`-Zustand zurück, der ehrlich „nicht gespeichert"
        // signalisiert.
        const fresh = readCurrentContent()
        const buffered = fresh.ok
          ? writeOfflineDraft(pageId, {
              content: fresh.content,
              baseSha: baseShaRef.current,
              branch: draft.branch,
              savedAt: new Date().toISOString(),
            })
          : false
        // Klassifizierung (welcher SaveOutcome an die Machine geht) in einem
        // reinen, node-getesteten Helfer — `offline` nur bei WIRKLICH
        // gelungener Pufferung, s. `save-failure.ts` (Fix-Runde 1, Finding 1).
        autosaveRef.current.onSaveResult(classifySaveFailure(err, buffered), Date.now())
      }
      bumpTick()
    },
    [pageId, bumpTick, readCurrentContent, draft.branch],
  )

  /** „Als Vorlage speichern …" (Task 6): liest den AKTUELLEN Editor-Stand über
   *  DENSELBEN Pfad wie Autosave (`readCurrentContent`, s. o. — KEINE zweite
   *  Serialisierungslogik) und ruft `saveAsTemplate` mit dem vollen Dokument
   *  (inkl. Seiten-Frontmatter, der Server trennt es über `splitFrontmatter`,
   *  s. `apps/api/README.md`). Ein Konvertierungsfehler (`ok:false`) wirft
   *  bewusst — der Dialog zeigt dafür dieselbe generische Fehlermeldung wie
   *  bei einem Netzwerk-/Serverfehler (Muster `new-page-button.tsx`s `catch`). */
  const handleSaveAsTemplateSubmit = useCallback(
    (name: string, description: string | undefined): Promise<SaveAsTemplateResult> => {
      const read = readCurrentContent()
      if (!read.ok) {
        return Promise.reject(new Error(t('editor.errors.contentUnreadable')))
      }
      return saveAsTemplate(space, { name, description, content: read.content })
    },
    [readCurrentContent, space, t],
  )

  const handleOpenSaveTemplateDialog = useCallback(() => setTemplateDialogOpen(true), [])
  const handleCloseSaveTemplateDialog = useCallback(() => setTemplateDialogOpen(false), [])

  /** Der Pfad für debounced/⌘S/Verlassen-Saves. Bei `ok:false` zählt der
   *  Versuch als Fehlversuch der Autosave-State-Machine (Backoff greift, nach
   *  3 Versuchen der sichtbare Fehlzustand — sinnvoll, weil ein erneuter
   *  Versuch ohne Neuladen der Seite ohnehin nicht helfen würde, s. Kommentar
   *  dort). Im WYSIWYG-Modus wird `findings` bei dieser Gelegenheit
   *  gleich mit aktualisiert („beim Save berechnet", s. `findings-panel.tsx`)
   *  — im Roh-Modus übernimmt das bereits der Lint-Lauf in `raw-editor.tsx`. */
  const performSave = useCallback(async () => {
    const read = readCurrentContent()
    if (!read.ok) {
      autosaveRef.current.onSaveResult('error', Date.now())
      bumpTick()
      return
    }
    // Critical-Fix (Final-Review Phase 2c Task 6): `read.content` ist das VOLLE
    // Dokument (inkl. Frontmatter, s. `readCurrentContent`) — der Offset muss
    // auf denselben String angewendet werden, den `checkEditorSupport` erhält.
    if (mode === 'wysiwyg') {
      const report = checkEditorSupport(read.content)
      setFindings(offsetFindingLines(report.findings, frontmatterLineOffset(read.content)))
    }
    await saveContent(read.content, baseShaRef.current)
  }, [readCurrentContent, saveContent, bumpTick, mode])

  const triggerFlush = useCallback(() => {
    const shouldSave = autosaveRef.current.flushNow(Date.now())
    bumpTick()
    if (shouldSave) void performSave()
  }, [performSave, bumpTick])

  const handleDirty = useCallback(() => {
    autosaveRef.current.onChange(Date.now())
    bumpTick()
  }, [bumpTick])

  /** EIN Feld im Metadaten-Formular ändert sich (`metadata-panel.tsx`). Schreibt
   *  den neuen Formular-Zustand SOFORT über `setFrontmatterMetadata` in
   *  `frontmatterRawRef.current` zurück (Spec: „Werte zurück ins Frontmatter",
   *  reine, getestete Funktion aus `@f451/markdown`) und markiert die Session
   *  als dirty — derselbe Autosave-/⌘S-/Save-Button-Pfad wie Body-Änderungen
   *  (`handleDirty` oben), kein zweiter Speicher-Mechanismus. Nur im
   *  WYSIWYG-Modus aufrufbar (`MetadataPanel`s `editable`-Prop ist im
   *  Roh-Modus `false`, s. dessen Kopfkommentar) — der Roh-Modus bleibt der
   *  einzige Frontmatter-Editor, solange er aktiv ist, damit niemals zwei
   *  gleichzeitig aktive Schreibpfade auf denselben Frontmatter-Block
   *  divergieren können. */
  const handleMetadataFieldChange = useCallback(
    (key: string, value: MetadataFormValue) => {
      if (!metadataSchema) return
      setMetadataFormValues((prev) => {
        const next = { ...prev, [key]: value }
        const metadataValues = toMetadataValues(metadataSchema, next)
        const newFrontmatterRaw = setFrontmatterMetadata(frontmatterRawRef.current, metadataValues)
        frontmatterRawRef.current = newFrontmatterRaw
        // Nested setState innerhalb dieses Updaters (statt eines zweiten,
        // eigenständigen `setMetadataAutoValues(...)`-Aufrufs danach) — so
        // hängt die Reihenfolge nicht davon ab, WANN React diesen Updater
        // tatsächlich ausführt: beide States werden aus demselben, hier
        // frisch berechneten `newFrontmatterRaw` abgeleitet.
        setMetadataAutoValues(rawMetadataFromFrontmatter(newFrontmatterRaw))
        return next
      })
      autosaveRef.current.onChange(Date.now())
      bumpTick()
    },
    [metadataSchema, bumpTick],
  )

  /** Gegenrichtung zu {@link handleMetadataFieldChange}: überall dort, wo
   *  `frontmatterRawRef.current` einen FRISCHEN Wert aus einem neu geparsten
   *  Dokument bekommt (Moduswechsel Roh→WYSIWYG, Normalisierung, Konflikt-/
   *  Reset-/Offline-Recovery — jede Stelle, die bislang schon `split.frontmatterRaw`
   *  zuweist), muss auch das Metadaten-Formular neu aus diesem Stand abgeleitet
   *  werden — sonst zeigte es nach einem Roh-Modus-Edit oder einer
   *  Konfliktlösung weiterhin die ALTEN Formular-Werte (Divergenz-Bug, Spec
   *  „beide dürfen nicht divergieren"). */
  const syncMetadataFromFrontmatter = useCallback(
    (raw: string) => {
      if (metadataSchema) setMetadataFormValues(deriveMetadataFormValues(metadataSchema, raw))
      setMetadataAutoValues(rawMetadataFromFrontmatter(raw))
      setTitleValue(titleFromFrontmatter(raw))
      setArchivedValue(archivedFromFrontmatter(raw))
    },
    [metadataSchema],
  )

  /** Titelfeld-Änderung (Feature „Sichtbares Titelfeld"): schreibt SOFORT über
   *  `setFrontmatterMetadata` in `frontmatterRawRef.current` zurück (identischer
   *  Schreibpfad wie `handleMetadataFieldChange`, KEIN zweiter Speicher-
   *  Mechanismus) und markiert die Session als dirty — Persistenz läuft über
   *  denselben Autosave-/⌘S-/Save-Button-Pfad wie jede andere Änderung. */
  const handleTitleChange = useCallback(
    (value: string) => {
      setTitleValue(value)
      frontmatterRawRef.current = setFrontmatterMetadata(frontmatterRawRef.current, { title: value })
      autosaveRef.current.onChange(Date.now())
      bumpTick()
    },
    [bumpTick],
  )

  /** „Archivieren"/„Aus Archiv holen"-Toggle (Feature „Archivieren") — wie
   *  {@link handleTitleChange}, aber `false` entfernt das Feld ganz (statt es
   *  explizit als `archived: false` zu schreiben): dieselbe „nicht gesetzt =
   *  nicht archiviert"-Konvention wie bei einer frisch angelegten Seite
   *  (`drafts/create-page.ts`s Initialinhalt enthält nie `archived:`). */
  const handleArchivedToggle = useCallback(() => {
    setArchivedValue((prev) => {
      const next = !prev
      frontmatterRawRef.current = setFrontmatterMetadata(frontmatterRawRef.current, {
        archived: next ? true : undefined,
      })
      return next
    })
    autosaveRef.current.onChange(Date.now())
    bumpTick()
  }, [bumpTick])

  // Timer für den nächsten fälligen Save — wird bei jeder Zustandsänderung der
  // Autosave-Instanz (jeder `bumpTick`) neu geplant; ein bereits laufender
  // `setTimeout` wird dabei verworfen (Cleanup) und durch einen frischen auf den
  // aktuellen `dueAt()` ersetzt. Genau dieser Mechanismus sorgt dafür, dass ein
  // Tippsturm nur EINEN tatsächlich feuernden Timer übrig lässt (s. autosave.test.ts).
  useEffect(() => {
    const due = autosaveRef.current.dueAt()
    if (due === null) return
    const delay = Math.max(0, due - Date.now())
    const id = setTimeout(() => triggerFlush(), delay)
    return () => clearTimeout(id)
  }, [tick, triggerFlush])

  // Expliziter Sofort-Save (Brief: „Moduswechsel, ⌘S, Verlassen") — gemeinsamer
  // Pfad für ⌘S UND den sichtbaren „Speichern"-Button in der Statuszeile
  // (Post-1-Zusatz, s. `status-bar.tsx`). Review-Fund 2: ein fokussierter
  // Konflikt-<dialog> lässt `keydown` zu `document` hochbubbeln — ohne die
  // Sperre hier würde ⌘S einen zweiten Save mit frischem Editor-Inhalt, aber
  // altem `baseSha` auslösen und den im Dialog angezeigten Vergleichsstand
  // ersetzen, während der Nutzer noch entscheidet; derselbe Guard schützt den
  // Button-Klick (kein zusätzlicher Weg, der ihn vergessen könnte). Liest den
  // Status direkt aus `autosaveRef` (nicht aus React-State `conflict`), weil
  // diese Funktion selbst über Renders hinweg stabil bleiben soll (`useCallback`
  // mit `[triggerFlush]`) und sonst einen veralteten Closure-Wert sähe — der Ref
  // ist immer aktuell.
  const handleImmediateSave = useCallback(() => {
    if (autosaveRef.current.getStatus().status === 'conflict') return
    triggerFlush()
  }, [triggerFlush])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        handleImmediateSave()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [handleImmediateSave])

  // „online"-Browser-Event (Phase 4b Task 2, Spec §9): Nachschub-Trigger, sobald
  // die Verbindung zurückkehrt — zusätzlich zum ohnehin laufenden 30s-Retry-Timer
  // oben (der greift bereits automatisch, weil `dueAt()` im `offline`-Zustand
  // einen fälligen Zeitpunkt liefert, s. autosave.ts). Der Guard auf `'offline'`
  // verhindert, dass ein `online`-Event in JEDEM anderen Zustand (z. B. `dirty`
  // mitten im normalen Debounce-Fenster) einen verfrühten Save erzwingt —
  // `flushNow` selbst würde das sonst zulassen (dirty|error|offline).
  useEffect(() => {
    function onOnline() {
      if (autosaveRef.current.getStatus().status === 'offline') triggerFlush()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [triggerFlush])

  // Soft-Lock-Heartbeat: läuft NICHT, solange `entryGateActive` gilt (Brief:
  // „bis dahin kein Heartbeat, der den fremden Lock stören würde") — der erste
  // Aufruf nach einem „Trotzdem bearbeiten"-Klick ist der „erneute heartbeatLock
  // NACH Klick" aus dem Brief. Danach läuft die Schleife bis zum Unmount durch,
  // unabhängig davon, ob `lockNotice` zwischendurch erneut auftaucht (Fall
  // „eigener Lock an einen anderen gefallen" — Banner zeigen, NICHT aufhören zu
  // heartbeaten, Soft-Lock blockiert nie hart).
  useEffect(() => {
    if (entryGateActive) return
    let cancelled = false

    function beat() {
      heartbeatLock(pageId)
        .then((info: LockInfo) => {
          if (cancelled) return
          setLockNotice(info.mine ? null : { heldBy: info.heldBy })
        })
        .catch(() => {
          // Reiner Hinweis-Charakter (Brief) — ein fehlgeschlagener Heartbeat
          // blockiert nichts, der nächste Intervall-Tick versucht es erneut.
        })
    }

    beat()
    const id = setInterval(beat, HEARTBEAT_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [pageId, entryGateActive])

  // Task-7-E2E-Fund (Flow 1: `lock.mine` war nach einem Moduswechsel unerwartet
  // `null`): `saveContent`/`readCurrentContent` sind über `useCallback` an `mode`
  // gekoppelt (`readCurrentContent` hängt direkt von `[mode]` ab) — standen sie in
  // DIESES Effects Dependency-Array, lief bei JEDEM Moduswechsel (WYSIWYG⇄Roh) ein
  // React-Effect-Teardown, dessen Cleanup unbedingt `releaseLock(pageId)` aufruft.
  // Der eigene Soft-Lock wäre dadurch bei jedem Moduswechsel freigegeben worden —
  // nicht nur beim echten Verlassen der Seite (Spec: „Verlassen gibt ihn frei",
  // nicht „Moduswechsel gibt ihn frei"). Fix: die beiden Callbacks über Refs
  // referenzieren (immer aktuell, ohne im Dependency-Array zu stehen) — das Effect
  // selbst hängt nur noch an `pageId`, sein Cleanup (inkl. `releaseLock`) läuft
  // dadurch wirklich nur beim Unmount dieser Session (Routenwechsel) oder wenn sich
  // `pageId` ändert (praktisch nie, da `EditorSession` ohnehin pro Draft-Branch neu
  // gemountet wird, s. `key={draft.branch}` in `EditorRoot`).
  const saveContentRef = useRef(saveContent)
  saveContentRef.current = saveContent
  const readCurrentContentRef = useRef(readCurrentContent)
  readCurrentContentRef.current = readCurrentContent

  // Phase 4b Task 5 (E2E-Fund, Störungs-Drehbuch „Token-Widerruf"): schützt
  // GENAU EINEN Unload-Save-Versuch pro Session vor Reentranz. Ohne diese
  // Sperre entsteht ein Navigations-Reset-Zyklus, real im E2E-Lauf als Hänger
  // bis zum Timeout beobachtet: der Keepalive-Save unten trifft bei einer
  // bereits weggefallenen Session (401) ebenfalls auf `client-api.ts`s
  // `redirectToLogin` — eine ERNEUTE `window.location.href`-Zuweisung, während
  // der Browser die VORHERIGE (durch genau denselben Mechanismus ausgelöste)
  // Navigation noch verarbeitet, verwirft diese und startet sie neu, wodurch
  // `beforeunload`/`pagehide` erneut feuern und der Zyklus nie committet.
  // `unloadHandledRef` lässt nur den ERSTEN `onUnload`-Aufruf tatsächlich
  // etwas tun — jeder weitere (egal ob `pagehide`- oder `beforeunload`-
  // ausgelöst) ist ein No-Op. Kein `useState`, weil dieser Guard selbst nie
  // einen Re-Render auslösen soll.
  const unloadHandledRef = useRef(false)

  // `releaseLock` beim Unmount (Routenwechsel) UND bei `pagehide` (Tab-Close/
  // Reload/externe Navigation — KEIN React-Unmount, deshalb ein eigener Pfad).
  // `beforeunload`/`pagehide` lösen zusätzlich einen Keepalive-Save aus, falls
  // gerade etwas Ungespeichertes ansteht (Brief: „flushNow mit keepalive").
  // `flushNow` liefert hier `false`, solange ein Konflikt offen ist (Review-Fund
  // 2 — s. autosave.ts) — der Dialog bleibt so auch über einen Tab-Close/Reload
  // hinweg die einzige Fortsetzung, kein zweiter Save mit altem `baseSha`.
  // Review-Fund 1: `saveContent` (statt eines separaten Fire-and-forget-Fetches)
  // meldet das Ergebnis über `onSaveResult` zurück — überlebt der JS-Kontext den
  // Unload (bfcache-Restore/iOS-Backgrounding), heilt sich der sonst dauerhaft
  // in `saving` hängende Zustand dadurch selbst.
  useEffect(() => {
    function onUnload() {
      if (unloadHandledRef.current) return // Reentranz-Sperre, s. Kommentar oben.
      unloadHandledRef.current = true
      releaseLock(pageId).catch(() => {})
      const shouldSave = autosaveRef.current.flushNow(Date.now())
      if (!shouldSave) return
      const read = readCurrentContentRef.current()
      if (!read.ok) {
        // Wie in `performSave`: ohne Rückmeldung bliebe die State-Machine nach
        // einem bfcache-Restore dauerhaft in `saving` hängen (Deadlock-Klasse
        // aus Review-Fund 1, hier über die Markdown-invalid-Tür erreicht).
        autosaveRef.current.onSaveResult('error', Date.now())
        return
      }
      void saveContentRef.current(read.content, baseShaRef.current, { keepalive: true })
    }
    window.addEventListener('pagehide', onUnload)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('pagehide', onUnload)
      window.removeEventListener('beforeunload', onUnload)
      releaseLock(pageId).catch(() => {})
    }
  }, [pageId])

  function handleOverride() {
    setEntryGateActive(false)
  }

  function handleDiscard() {
    setDiscardError(null)
    discardDraft(pageId)
      .then(() => router.push(backHref))
      .catch(async (err) => {
        // 404: there is no draft any more (already discarded, released in
        // another tab, reset, or an interrupted create). Nothing to retry —
        // leave the editor. A page that was never released has no reading
        // view, so go to the space instead (#22).
        if (err instanceof ClientApiError && err.status === 404) {
          const released = await fetch(`/api/pages/${encodeURIComponent(pageId)}`, { credentials: 'same-origin' })
            .then((res) => res.ok)
            .catch(() => false)
          router.push(released ? backHref : wikiSpaceHref(space))
          return
        }
        setDiscardError(t('editor.errors.discardFailed'))
      })
  }

  function handleBackToReading() {
    triggerFlush()
    router.push(backHref)
  }

  /** „Als Markdown exportieren" (Feature „Markdown-Export"): löst den Download
   *  über `GET /api/pages/:id/raw?download=1` aus (`apiPageRawPath`) — läuft
   *  same-origin über den Next-Rewrite (Muster `client-api.ts`s Modulkommentar),
   *  ein `<a download>`-Klick genügt daher, KEIN fetch+Blob-Umweg nötig. */
  function handleExportMarkdown() {
    const anchor = document.createElement('a')
    anchor.href = apiPageRawPath(pageId, { download: true })
    // `download` (leer = Dateiname vom Server übernehmen, s. `Content-Disposition`
    // oben) erzwingt den Download-Navigationstyp selbst dann, wenn der Header aus
    // irgendeinem Grund fehlt — Redundanz zur serverseitigen Absicherung, kein
    // Ersatz dafür.
    anchor.download = ''
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  /** „Seite löschen": die Bestätigung liegt bereits in `StatusBar#handleDeletePageClick`
   *  (Muster `handleDiscard`) — hier läuft nur noch der API-Aufruf + die
   *  Navigation zur Space-Startseite bei Erfolg. `router.refresh()` NACH dem
   *  `push` (Muster `review-view.tsx#handleMerge`, Task 8): die Space-Layout-
   *  Route (trägt den Seitenbaum) ist zwischen `/edit` und der Space-
   *  Startseite derselbe Next-Router-Segment-Baum — ein reiner `push` behält
   *  dessen gecachten Stand bei (Soft-Navigation), Seitenbaum UND
   *  Space-Startseite zeigten die gerade gelöschte Seite deshalb weiter an,
   *  solange derselbe Tab ohne harten Reload weiterlief. `refresh()`
   *  invalidiert den Router-Cache der Zielroute (inkl. Layout/Seitenbaum) und
   *  erzwingt einen frischen Server-Fetch. */
  function handleDeletePage() {
    deletePage(pageId)
      .then(() => {
        router.push(wikiSpaceHref(space))
        router.refresh()
      })
      .catch(() => {
        window.alert(t('editor.errors.deletePageFailed'))
      })
  }

  /** „Review anfordern" (Task 6): `flushNow` VOR dem Aufruf (Muster
   *  Moduswechsel, s. `handleSwitchToRaw`) — kein Warten auf dessen Abschluss,
   *  derselbe fire-and-forget-Charakter wie überall sonst in dieser Datei.
   *  `mergeable:false` in der Antwort ist bewusst KEIN Sonderfall: die
   *  Navigation läuft in JEDEM Erfolgsfall (die Konflikt-Notice auf der
   *  Review-Seite, Task 7, zeigt den Zustand dann an). */
  function handleRequestReview() {
    triggerFlush()
    setRequestingReview(true)
    requestReview(pageId)
      .then((result) => {
        if (result.ok) {
          router.push(wikiPageReviewHref(space, pageId))
          return
        }
        setRequestingReview(false)
        if (result.reason === 'no-changes') {
          window.alert(t('editor.errors.reviewNoChanges'))
          return
        }
        window.alert(t('editor.errors.reviewNoDraft'))
      })
      .catch(() => {
        setRequestingReview(false)
        window.alert(t('editor.errors.reviewFailed'))
      })
  }

  function handleKeepServerVersion() {
    if (!conflict) return
    const split = splitFrontmatter(conflict.currentContent)
    frontmatterRawRef.current = split.frontmatterRaw
    syncMetadataFromFrontmatter(split.frontmatterRaw)
    baseShaRef.current = conflict.currentSha
    setMountBody(split.body)
    // Task 6: das Roh-Modus-Gegenstück gleich mit — `conflict.currentContent`
    // ist bereits das VOLLE Dokument, kein erneutes `joinFrontmatter` nötig.
    setMountRawContent(conflict.currentContent)
    setConflict(null)
    // Fix-Runde 1, Finding 2: „Serverstand übernehmen" verwirft die eigene
    // Fassung bewusst — ein evtl. offline gepufferter Stand (schon EIN
    // transienter Fehlversuch vor dem 409 schreibt ihn) gehört damit endgültig
    // weg, sonst böte Task-3-Recovery ihn beim nächsten Mount wieder an
    // („Daten-Auferstehung" eines gerade explizit verworfenen Inhalts).
    clearOfflineDraft(pageId)
    // Der Serverstand ist jetzt der (unveränderte) Ausgangsstand — nichts mehr zu
    // speichern. Eine frische Autosave-Instanz statt eines Reset-Aufrufs, weil
    // `autosave.ts` bewusst keine Reset-Methode exponiert (s. dortiger Kommentar:
    // die einzige Fortsetzung aus `conflict` ist entweder das hier oder `flushNow`).
    autosaveRef.current = createAutosave({ debounceMs: AUTOSAVE_DEBOUNCE_MS })
    setRemountKey((k) => k + 1)
    bumpTick()
  }

  /** Finding 1 (Fix-Runde 1) — „Inhalt in den Editor übernehmen": setzt den
   *  geretteten Inhalt als neuen Mount-Stand für BEIDE Modi (Muster
   *  `handleKeepServerVersion`, `content` ist wie dort das VOLLE Dokument)
   *  und markiert ihn als ausstehende Änderung — der nächste Autosave-Lauf
   *  sichert ihn regulär (in den Draft, der `updateDraft` zufolge entweder
   *  noch existiert — dann greift ggf. der bestehende 409-Konflikt-Pfad, falls
   *  `baseSha` inzwischen veraltet ist — oder beim nächsten Neuladen der Seite
   *  frisch angelegt wird). KEIN zusätzlicher Retry-Mechanismus (Brief:
   *  „kein Overengineering") — die bereits vorhandene Autosave-/Konflikt-
   *  Maschinerie reicht, „kein stiller Verlust" ist mit dem sichtbaren
   *  Dialog + dieser Übernahme bereits erfüllt. */
  function handleApplyResetRecovery() {
    if (!resetRecovery) return
    const content = resetRecovery.preservedContent
    const split = splitFrontmatter(content)
    frontmatterRawRef.current = split.frontmatterRaw
    syncMetadataFromFrontmatter(split.frontmatterRaw)
    setMountBody(split.body)
    setMountRawContent(content)
    setRemountKey((k) => k + 1)
    autosaveRef.current.onChange(Date.now())
    bumpTick()
    onDismissResetRecovery()
  }

  /** „Verwerfen"-Sekundäraktion — fragt EXPLIZIT nach (Muster
   *  `status-bar.tsx#handleDiscardClick`): danach ist der gerettete Inhalt
   *  endgültig weg, anders als beim Wegklicken des Dialogs (den es hier
   *  bewusst nicht gibt, s. `ResetRecoveryDialog`-Kopfkommentar). */
  function handleDiscardResetRecovery() {
    if (window.confirm(t('editor.confirm.discardResetRecovery'))) {
      onDismissResetRecovery()
    }
  }

  /** „Übernehmen" (Phase 4b Task 3): setzt den gepufferten Inhalt als neuen
   *  Mount-Stand für BEIDE Modi (Muster `handleApplyResetRecovery` 1:1 — auch
   *  hier ist `content` das VOLLE Dokument) und markiert ihn als ausstehende
   *  Änderung, damit der nächste Autosave-Lauf ihn regulär sichert. Der
   *  Puffer selbst bleibt bewusst BESTEHEN (kein `clearOfflineDraft` hier) —
   *  erst ein erfolgreicher Save räumt ihn (`saveContent`s Erfolgspfad, Task
   *  2): geht der Save schief (z. B. weiterhin offline), bleibt der Stand
   *  dadurch auch über einen erneuten Reload hinweg gesichert. */
  function handleApplyOfflineRecovery() {
    if (!offlineRecovery) return
    const content = offlineRecovery.content
    const split = splitFrontmatter(content)
    frontmatterRawRef.current = split.frontmatterRaw
    syncMetadataFromFrontmatter(split.frontmatterRaw)
    setMountBody(split.body)
    setMountRawContent(content)
    setRemountKey((k) => k + 1)
    autosaveRef.current.onChange(Date.now())
    bumpTick()
    onDismissOfflineRecovery()
  }

  /** „Verwerfen" — räumt den Puffer endgültig, der Editor bleibt beim bereits
   *  geladenen Server-Stand (normaler Mount, keine weitere Aktion nötig). */
  function handleDiscardOfflineRecovery() {
    clearOfflineDraft(pageId)
    onDismissOfflineRecovery()
  }

  function handleKeepMyVersion() {
    if (!conflict) return
    const { localContent, currentSha } = conflict
    setConflict(null)
    // `resolveConflict` (NICHT `flushNow` — das ist seit Review-Fund 2 aus
    // `conflict` heraus IMMER `false`, s. autosave.ts) ist die einzige
    // Fortsetzung aus diesem Zustand statt eines automatischen Timer-Pfads.
    const shouldSave = autosaveRef.current.resolveConflict(Date.now())
    bumpTick()
    if (shouldSave) void saveContent(localContent, currentSha)
  }

  // --- Task 6: Moduswechsel ---------------------------------------------
  //
  // WYSIWYG→Roh ist laut Spec IMMER erlaubt — `flushNow` VOR dem Wechsel
  // (Brief), dann der aktuelle WYSIWYG-Inhalt als neuer Roh-Mount-Stand.
  // Schlägt `getMarkdownBody()` ausnahmsweise fehl (Konvertierungsfehler, s.
  // `wysiwyg-editor.tsx`), fällt dies auf den letzten bekannten `mountBody`
  // zurück statt abzustürzen — der Editor zeigt sein eigenes Fehlerbanner
  // ohnehin bereits, hier zählt nur „nicht crashen, keine Endlosschleife".
  //
  // Beide Handler brechen früh ab, wenn der Zielmodus bereits aktiv ist: ein
  // redundanter Klick auf den schon aktiven Tab dürfte NIE den jeweils
  // anderen (nicht gemounteten, daher zwangsläufig veralteten) Mount-Stand
  // über den aktuell editierten überschreiben.
  const handleSwitchToRaw = useCallback(() => {
    if (mode === 'raw') return
    const read = readCurrentContent()
    triggerFlush()
    const content = read.ok ? read.content : joinFrontmatter(frontmatterRawRef.current, mountBody)
    setMountRawContent(content)
    setMode('raw')
    setWysiwygBlockReason(null)
  }, [mode, readCurrentContent, triggerFlush, mountBody])

  // Roh→WYSIWYG läuft über `evaluateModeSwitch` (Spec-Anker: „Syntax, die der
  // Editor nicht darstellen kann, wird VOR dem Wechsel gemeldet"). Bei
  // Ablehnung ändert sich `mode` schlicht nicht — der WYSIWYG-Tab bleibt
  // dadurch der inaktive Tab, das `findings-panel` öffnet mit der vollen
  // Begründung (Brief: „Begründung statt stilles Nichtstun").
  const handleSwitchToWysiwyg = useCallback(() => {
    if (mode === 'wysiwyg') return
    const content = rawEditorRef.current?.getContent() ?? mountRawContent
    const result = evaluateModeSwitch(content)
    // Critical-Fix (Final-Review Phase 2c Task 6): `evaluateModeSwitch` gibt
    // `checkEditorSupport`s BODY-relative Zeilen unverändert weiter (s. dessen
    // Tests) — `content` hier ist das VOLLE Dokument, der Offset muss also auch
    // hier vor jeder Anzeige/jedem State angewendet werden.
    const offsetFindings = offsetFindingLines(result.findings, frontmatterLineOffset(content))
    setFindings(offsetFindings)

    if (!result.allowed) {
      setWysiwygBlockReason(describeBlockReason(offsetFindings, t))
      setFindingsPanelOpen(true)
      return
    }

    if (result.needsConfirmation) {
      setPendingConfirm({ findings: offsetFindings, canonicalBody: result.canonicalBody, rawContent: content })
      return
    }

    const split = splitFrontmatter(content)
    frontmatterRawRef.current = split.frontmatterRaw
    syncMetadataFromFrontmatter(split.frontmatterRaw)
    setMountBody(split.body)
    setMode('wysiwyg')
    setWysiwygBlockReason(null)
  }, [mode, mountRawContent, syncMetadataFromFrontmatter, t])

  // „Normalisieren und wechseln" — übernimmt `canonicalBody` (den Stand, den
  // der Editor ohnehin speichern würde) als neuen WYSIWYG-Ausgangsstand.
  // `onChange` markiert dies explizit als ausstehende Änderung: auch wenn der
  // Nutzer seit dem Laden nichts getippt hat, unterscheidet sich `canonicalBody`
  // vom zuletzt gespeicherten Server-Stand — ohne diesen Aufruf verschwände die
  // Normalisierung nie im Server-Stand (kein Timer/Save würde je auslösen).
  // `findings` wird auf dem NEUEN (bereits kanonischen) Stand neu berechnet —
  // sonst zeigte das Panel den soeben aufgelösten `normalization`-Befund
  // fälschlich als weiterhin offen an.
  const handleConfirmNormalize = useCallback(() => {
    if (!pendingConfirm) return
    const { frontmatterRaw: newFrontmatterRaw } = splitFrontmatter(pendingConfirm.rawContent)
    frontmatterRawRef.current = newFrontmatterRaw
    syncMetadataFromFrontmatter(newFrontmatterRaw)
    setMountBody(pendingConfirm.canonicalBody)
    setMode('wysiwyg')
    setWysiwygBlockReason(null)
    setPendingConfirm(null)
    // Critical-Fix (Final-Review Phase 2c Task 6): derselbe Offset-Schritt wie
    // überall sonst — `joinFrontmatter(...)` hier ist das VOLLE Dokument.
    const normalizedFull = joinFrontmatter(newFrontmatterRaw, pendingConfirm.canonicalBody)
    setFindings(offsetFindingLines(checkEditorSupport(normalizedFull).findings, frontmatterLineOffset(normalizedFull)))
    autosaveRef.current.onChange(Date.now())
    bumpTick()
  }, [pendingConfirm, bumpTick, syncMetadataFromFrontmatter])

  const handleCancelConfirm = useCallback(() => {
    setPendingConfirm(null)
  }, [])

  const saveStatus = autosaveRef.current.getStatus().status
  const editable = !entryGateActive

  return (
    <div className="editor-root">
      {discardError ? (
        <div className="callout error" role="alert">
          <p>{discardError}</p>
        </div>
      ) : null}
      <StatusBar
        space={space}
        title={title}
        backHref={backHref}
        saveStatus={saveStatus}
        savedAt={savedAt}
        onDiscard={handleDiscard}
        onBackToReading={handleBackToReading}
        onSave={handleImmediateSave}
        onRequestReview={handleRequestReview}
        requestReviewDisabled={conflict !== null || requestingReview}
        onResetToLastRelease={onResetToLastRelease}
        onSaveAsTemplate={handleOpenSaveTemplateDialog}
        onExportMarkdown={handleExportMarkdown}
        onDeletePage={handleDeletePage}
      />
      {lockNotice ? <LockBanner heldBy={lockNotice.heldBy} onOverride={handleOverride} /> : null}
      <TitleField
        title={titleValue}
        archived={archivedValue}
        editable={editable && mode === 'wysiwyg'}
        onTitleChange={handleTitleChange}
        onArchivedToggle={handleArchivedToggle}
      />
      <MetadataPanel
        schema={metadataSchema}
        values={metadataFormValues}
        autoValues={metadataAutoValues}
        onFieldChange={handleMetadataFieldChange}
        open={metadataPanelOpen}
        onOpenChange={setMetadataPanelOpen}
        editable={editable && mode === 'wysiwyg'}
      />
      {mode === 'wysiwyg' ? (
        <WysiwygEditor
          key={remountKey}
          ref={wysiwygRef}
          pageId={pageId}
          space={space}
          body={mountBody}
          onDirty={handleDirty}
          editable={editable}
        />
      ) : (
        <RawEditor
          key={remountKey}
          ref={rawEditorRef}
          content={mountRawContent}
          onDirty={handleDirty}
          onFindingsChange={setFindings}
          editable={editable}
        />
      )}
      <div className="editorfoot">
        <ModeSwitch
          mode={mode}
          wysiwygBlockReason={wysiwygBlockReason}
          onSwitchToWysiwyg={handleSwitchToWysiwyg}
          onSwitchToRaw={handleSwitchToRaw}
          pendingConfirm={pendingConfirm}
          onConfirmNormalize={handleConfirmNormalize}
          onCancelConfirm={handleCancelConfirm}
        />
        <span className="grow" />
        <FindingsPanel
          findings={findings}
          open={findingsPanelOpen}
          onOpenChange={setFindingsPanelOpen}
          onLineClick={mode === 'raw' ? (line) => rawEditorRef.current?.scrollToLine(line) : undefined}
        />
      </div>
      <ConflictDialog
        open={conflict !== null}
        localContent={conflict?.localContent ?? ''}
        currentContent={conflict?.currentContent ?? ''}
        onKeepServerVersion={handleKeepServerVersion}
        onKeepMyVersion={handleKeepMyVersion}
      />
      <ResetRecoveryDialog
        open={resetRecovery !== null}
        preservedContent={resetRecovery?.preservedContent ?? ''}
        onApply={handleApplyResetRecovery}
        onDiscard={handleDiscardResetRecovery}
      />
      <OfflineRecoveryDialog
        open={offlineRecovery !== null}
        savedAt={offlineRecovery?.savedAt ?? ''}
        foreignBranch={offlineRecovery?.foreignBranch ?? false}
        onApply={handleApplyOfflineRecovery}
        onDiscard={handleDiscardOfflineRecovery}
      />
      <SaveTemplateDialog
        open={templateDialogOpen}
        onClose={handleCloseSaveTemplateDialog}
        onSubmit={handleSaveAsTemplateSubmit}
      />
    </div>
  )
}

/**
 * Client-Insel-Wurzel des Editors (Phase 2c). Ruft beim Mount `createDraft` auf
 * (idempotent: legt den Draft-Branch an oder liefert den Bestand unverändert
 * zurück), entscheidet den Startmodus über `checkEditorSupport` aus
 * `@f451/editor` und trennt den geladenen Inhalt per `splitFrontmatter`. Die
 * gesamte Session-Verdrahtung (Autosave, Soft-Lock, Statuszeile, Konflikt-Dialog
 * — Task 4; Review anfordern/Zurücksetzen — Task 6) lebt in `EditorSession`,
 * gemountet mit `key={draft.branch}#{resetGen}` (`resetGen` s. unten —
 * „Auf letzte Freigabe zurücksetzen" ändert den Branch-Namen NICHT, ohne den
 * Zähler bliebe der React-Key nach einem Reset unverändert).
 *
 * Fehlerfälle laut Draft-API-Vertrag (`resolveWriteContext` in
 * `apps/api/src/routes/drafts.ts`): `502` (Provider nicht erreichbar) zeigt
 * eine Fehlerkarte MIT Retry-Button (transienter Fehler); `403` (kein
 * Schreibrecht) zeigt eine Fehlerkarte OHNE Retry — die `action:'connect'`-
 * Variante (kein verknüpftes Provider-Konto) ist laut 2a-Triage strukturell
 * unerreichbar, sobald der Nutzer bis zur Wiki-Leseansicht (und damit hierher)
 * gekommen ist, deshalb genügt eine generische 403-Meldung, ohne danach zu
 * unterscheiden. Jeder andere Fehlerstatus fällt auf dieselbe Fehlerkarte MIT
 * Retry zurück (nie eine leere Seite ohne Erklärung).
 */
export function EditorRoot({ pageId, space, title, metadataSchema }: EditorRootProps) {
  const { t } = useT()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // Unmount-Guard (Task-2-Review-Fund): ein `mounted`-Flag statt eines
  // AbortControllers, weil `createDraft` kein `signal` entgegennimmt — EIN
  // geteiltes Flag deckt sowohl den Mount-Aufruf als auch den manuellen
  // „Erneut versuchen"-Klick ab (eine Closure-Variable pro Aufruf, wie in
  // einem früheren Entwurf dieser Datei, hätte den Retry-Klick-Pfad NICHT
  // erfasst — genau der Bug, den dieser Guard beheben soll).
  const mountedRef = useRef(true)
  // Task 6: „Auf letzte Freigabe zurücksetzen" — `updateDraft({strategy:
  // 'take-main'})` liefert für DENSELBEN Draft-Branch (Name unverändert)
  // einen komplett neuen Inhalts-/`baseSha`-Stand zurück. `key={state.draft.branch}`
  // allein würde deshalb KEINEN Remount auslösen — dieser Zähler wird bei
  // jedem erfolgreichen Reset erhöht und ergänzt den Key (s. `<EditorSession>`
  // unten), damit `EditorSession` wirklich sauber neu mountet (Autosave-Instanz,
  // `baseShaRef`, Soft-Lock-Gate — dieselbe Begründung wie beim Konflikt-Retry,
  // s. `EditorSession`-Kopfkommentar).
  const [resetGen, setResetGen] = useState(0)
  // Finding 1 (Fix-Runde 1): `updateDraft`s `502` kann `preservedContent`
  // tragen (Content-Verlust-Fenster NACH dem Verwerfen des alten
  // Draft-Branchs, s. `lib/editor/reset-recovery.ts`-Modulkommentar) — bis der
  // Nutzer sich in `ResetRecoveryDialog` entscheidet, lebt dieser Inhalt HIER
  // (nicht im schon-gemounteten `EditorSession`-State selbst), weil er auch
  // dann sichtbar bleiben muss, wenn `EditorSession` aus irgendeinem Grund
  // zwischenzeitlich neu mounten würde — `EditorSession` liest ihn nur über
  // die Props, die Übernahme selbst (Editor-Inhalt setzen, dirty markieren)
  // braucht deren Refs/State und lebt dort.
  const [resetRecovery, setResetRecovery] = useState<{ preservedContent: string } | null>(null)
  const dismissResetRecovery = useCallback(() => setResetRecovery(null), [])
  // Phase 4b Task 3 (Spec §9, Mount-Recovery): analog zu `resetRecovery` oben
  // — lebt hier (nicht in `EditorSession`), weil die Auswertung bereits in
  // `load()` läuft, BEVOR `EditorSession` überhaupt mountet. `null` = kein
  // Dialog (entweder gar kein Puffer oder Regel 2 aus `evaluateOfflineRecovery`
  // — dann wurde er in `load()` bereits still geräumt).
  const [offlineRecovery, setOfflineRecovery] = useState<{ content: string; savedAt: string; foreignBranch: boolean } | null>(
    null,
  )
  const dismissOfflineRecovery = useCallback(() => setOfflineRecovery(null), [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(() => {
    setState({ status: 'loading' })
    createDraft(pageId)
      .then((draft) => {
        if (!mountedRef.current) return
        const rawSupport = checkEditorSupport(draft.content)
        // Critical-Fix (Final-Review Phase 2c Task 6): `rawSupport.findings[].line`
        // ist BODY-relativ — bereits der Startzustand des `findings-panel` muss
        // die volle Dokumentzeile zeigen (s. `frontmatter-offset.ts`-Kopfkommentar).
        const support: EditorSupportReport = {
          ...rawSupport,
          findings: offsetFindingLines(rawSupport.findings, frontmatterLineOffset(draft.content)),
        }
        const { frontmatterRaw, body } = splitFrontmatter(draft.content)
        setState({ status: 'ready', draft, startMode: startModeOf(support), support, frontmatterRaw, body })
        // Mount-Recovery (Phase 4b Task 3, Spec §9): liest NUR, was gerade
        // tatsächlich im Puffer liegt — ein von Task 2 nach
        // `handleKeepServerVersion` bereits geräumter Puffer existiert hier
        // schlicht nicht mehr (`readOfflineDraft` liefert `null`), wird also
        // auch nicht wiederbelebt. `evaluateOfflineRecovery` entscheidet
        // konservativ (s. dortiger Kopfkommentar); bei `'none'` UND
        // vorhandenem Puffer war der Inhalt identisch — dann räumt DIESER
        // Aufrufer ihn still (kein Dialog für ein Ergebnis ohne Mehrwert).
        const buffered = readOfflineDraft(pageId)
        const decision = evaluateOfflineRecovery(buffered, { branch: draft.branch, content: draft.content })
        if (decision === 'none') {
          if (buffered) clearOfflineDraft(pageId)
        } else if (buffered) {
          setOfflineRecovery({
            content: buffered.content,
            savedAt: buffered.savedAt,
            foreignBranch: buffered.branch !== draft.branch,
          })
        }
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        if (err instanceof ClientApiError && err.status === 403) {
          setState({
            status: 'error',
            retryable: false,
            message: t('editor.errors.noWriteAccess'),
          })
          return
        }
        if (err instanceof ClientApiError && err.status === 502) {
          setState({
            status: 'error',
            retryable: true,
            message: t('editor.errors.serverUnreachable'),
          })
          return
        }
        // SessionExpiredError (401) hat die Umleitung bereits ausgelöst
        // (client-api.ts#redirectToLogin) — hier bleibt nur noch eine
        // Fehlerkarte für den kurzen Moment bis zur Navigation. Jeder andere
        // Fehler (Netzwerk, 404, unbekannter Status) bekommt dieselbe
        // generische Fehlerkarte mit Retry.
        setState({
          status: 'error',
          retryable: true,
          message: t('editor.errors.loadFailed'),
        })
      })
  }, [pageId, t])

  /** „Auf letzte Freigabe zurücksetzen" (Task 6) — die Bestätigung liegt
   *  bereits in `StatusBar#handleResetClick`, hier läuft nur noch der
   *  API-Aufruf + der Remount. Nutzt die funktionale `setState`-Form (statt
   *  `state` in den Dependencies), damit der aktuelle `draft.branch` auch
   *  nach mehreren Resets in Folge (`resetGen` steigt, `load` selbst bleibt
   *  stabil an `pageId` gebunden) korrekt gelesen wird. */
  const handleResetToLastRelease = useCallback(() => {
    updateDraft(pageId, 'take-main')
      .then((result) => {
        if (!mountedRef.current) return
        if (!result.ok) {
          const outcome = describeResetFailure(result, t)
          if (outcome.kind === 'recoverable') {
            // KEIN alert — der geretteten Inhalt still per `window.alert` zu
            // melden UND wegzuwerfen wäre exakt der Finding-1-Bug. Der Dialog
            // ist die einzige Fortsetzung, s. `ResetRecoveryDialog`.
            setResetRecovery({ preservedContent: outcome.preservedContent })
            return
          }
          window.alert(outcome.message)
          return
        }
        setState((prev) => {
          if (prev.status !== 'ready') return prev
          const rawSupport = checkEditorSupport(result.info.content)
          const support: EditorSupportReport = {
            ...rawSupport,
            findings: offsetFindingLines(rawSupport.findings, frontmatterLineOffset(result.info.content)),
          }
          const { frontmatterRaw, body } = splitFrontmatter(result.info.content)
          return {
            status: 'ready',
            // `branch` bleibt identisch (deterministisch aus `pageId`
            // abgeleitet server-seitig) — `lock: null` ist eine bewusste
            // Vereinfachung: `POST /draft/update` liefert keine Lock-Auskunft
            // zurück, aber die Person, die GERADE den Reset ausgelöst hat,
            // ist per Definition die aktiv Bearbeitende — kein Soft-Lock-Gate
            // nötig, der nächste Heartbeat bestätigt `mine:true` ohnehin.
            draft: { branch: prev.draft.branch, baseSha: result.info.baseSha, content: result.info.content, lock: null },
            startMode: startModeOf(support),
            support,
            frontmatterRaw,
            body,
          }
        })
        setResetGen((g) => g + 1)
      })
      .catch(() => {
        if (!mountedRef.current) return
        window.alert(t('editor.errors.resetFailed'))
      })
  }, [pageId, t])

  useEffect(() => {
    load()
  }, [load])

  if (state.status === 'loading') {
    return (
      <div className="editor-root" aria-busy="true">
        <p>{t('editor.loading')}</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="callout error" role="alert">
        <p>{state.message}</p>
        {state.retryable ? (
          <div className="btn-row">
            <button type="button" className="btn primary" onClick={load}>
              {t('editor.retry')}
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <EditorSession
      key={`${state.draft.branch}#${resetGen}`}
      pageId={pageId}
      space={space}
      title={title}
      metadataSchema={metadataSchema}
      draft={state.draft}
      startMode={state.startMode}
      support={state.support}
      frontmatterRaw={state.frontmatterRaw}
      body={state.body}
      onResetToLastRelease={handleResetToLastRelease}
      resetRecovery={resetRecovery}
      onDismissResetRecovery={dismissResetRecovery}
      offlineRecovery={offlineRecovery}
      onDismissOfflineRecovery={dismissOfflineRecovery}
    />
  )
}
