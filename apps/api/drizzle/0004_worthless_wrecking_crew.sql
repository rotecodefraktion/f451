-- P1-Fix aus Phase 2a (Phase 2d Task 1): `edges.ref` NOT NULL DEFAULT 'main' +
-- spaltenselektives `ON DELETE SET NULL (to_page_id)` auf dem `(to_page_id, ref)`-FK.
-- Ausführliche Begründung: Kommentar bei `edges.ref` in apps/api/src/db/schema.ts.
--
-- Bestehende Zeilen können `ref = NULL` haben (aus dem alten, spaltenUNselektiven
-- `ON DELETE SET NULL`, das beim Löschen einer Zielseite bislang BEIDE Spalten
-- gemeinsam genullt hat) — vor dem NOT NULL auf 'main' normalisieren, sonst
-- scheitert die folgende ALTER COLUMN ... SET NOT NULL an vorhandenen Zeilen.
UPDATE "edges" SET "ref" = 'main' WHERE "ref" IS NULL;--> statement-breakpoint
ALTER TABLE "edges" ALTER COLUMN "ref" SET NOT NULL;--> statement-breakpoint
-- PG15-Sondersyntax `ON DELETE SET NULL (<Spalte>)`: nullt beim Löschen der
-- referenzierten pages-Zeile NUR `to_page_id`, nicht `ref` — Drizzle kann das
-- nicht generieren (ForeignKeyBuilder#onDelete kennt keine Spaltenliste),
-- daher hier von Hand. Der Constraint-Name bleibt unverändert (aus Migration
-- 0001), nur die Aktion ändert sich.
ALTER TABLE "edges" DROP CONSTRAINT "edges_to_page_id_ref_pages_id_ref_fk";--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_to_page_id_ref_pages_id_ref_fk" FOREIGN KEY ("to_page_id","ref") REFERENCES "public"."pages"("id","ref") ON DELETE SET NULL ("to_page_id") ON UPDATE no action;
