import { eq } from 'drizzle-orm'
import type { GitProvider } from '@f451/git-provider'
import type { Db } from '../db/client.js'
import { spaces as spacesTable } from '../db/schema.js'
import type { OpsCounters } from '../ops/counters.js'
import type { SpaceConfig } from '../spaces/config.js'
import { indexSpace, type IndexerDeps, type IndexerLogger, type IndexReport } from './index-space.js'

export interface DriftDeps {
  db: Db
  providerRegistry: (space: SpaceConfig) => GitProvider
  logger?: IndexerLogger
  /** Injectable für Tests (Spy): Default ist der echte `indexSpace`. */
  indexSpace?: (deps: IndexerDeps, space: SpaceConfig) => Promise<IndexReport>
  /** Task 5 (Betrieb): erhöht `drift_errors`, wenn der HEAD-Abgleich für einen
   *  Space fehlschlägt (Provider nicht erreichbar o. Ä., siehe Catch-Zweig
   *  unten) — UND wird an `indexSpace` durchgereicht, damit dessen eigene
   *  `indexer_errors` (IO-Fehler beim Lesen einzelner Dateien) ebenfalls
   *  gezählt werden. Optional, damit Bestandsaufrufe (Tests) ohne Zähler
   *  weiterlaufen. */
  counters?: OpsCounters
}

export interface DriftResult {
  spaceId: string
  /** true, wenn der HEAD-SHA vom zuletzt indexierten abwich (oder noch nie/unvollständig
   *  indexiert wurde, siehe `indexedHeadSha === null`) UND deshalb ein Reindex lief. */
  drifted: boolean
  /** Nur gesetzt, wenn `drifted` true ist. */
  report?: IndexReport
  /** Nur gesetzt, wenn der Abgleich für diesen Space fehlgeschlagen ist. */
  error?: unknown
}

/**
 * HEAD-Abgleich-Job (Plan Task 5): vergleicht je Space den aktuellen HEAD-SHA
 * des `main`-Refs mit dem zuletzt vollständig indexierten (`spaces.indexedHeadSha`
 * in der DB). Abweichung ODER `null` (noch nie indexiert, oder der letzte Lauf
 * war wegen eines transienten IO-Fehlers unvollständig — siehe `IndexReport.filesSkippedIo`
 * in `index-space.ts`, das `indexedHeadSha` in diesem Fall bewusst NICHT vorrückt)
 * löst einen Voll-Reindex aus.
 *
 * Ein Fehler bei einem einzelnen Space (z. B. Provider nicht erreichbar) wird
 * gefangen und geloggt; die übrigen Spaces werden trotzdem abgeglichen.
 */
export async function checkDrift(
  deps: DriftDeps,
  spaceConfigs: readonly SpaceConfig[],
): Promise<DriftResult[]> {
  const doIndexSpace = deps.indexSpace ?? indexSpace
  const results: DriftResult[] = []

  for (const space of spaceConfigs) {
    try {
      const provider = deps.providerRegistry(space)
      const headSha = await provider.getHeadSha(space.repoRef, 'main')

      const rows = await deps.db
        .select({ indexedHeadSha: spacesTable.indexedHeadSha })
        .from(spacesTable)
        .where(eq(spacesTable.id, space.id))
      const indexedHeadSha = rows[0]?.indexedHeadSha ?? null

      if (indexedHeadSha === null || indexedHeadSha !== headSha) {
        const report = await doIndexSpace(
          { db: deps.db, provider, logger: deps.logger, counters: deps.counters },
          space,
        )
        results.push({ spaceId: space.id, drifted: true, report })
      } else {
        results.push({ spaceId: space.id, drifted: false })
      }
    } catch (error) {
      deps.logger?.warn(`drift: HEAD-Abgleich für Space "${space.id}" fehlgeschlagen`, {
        spaceId: space.id,
        error: error instanceof Error ? error.message : String(error),
      })
      // Task 5 (Betrieb): echter Fehlerpfad — der Abgleich für DIESEN Space ist
      // gescheitert (z. B. Provider nicht erreichbar), nicht bloß "kein Drift".
      deps.counters?.increment('drift_errors')
      results.push({ spaceId: space.id, drifted: false, error })
    }
  }

  return results
}
