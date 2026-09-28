-- Fix P1-Backlog aus Phase 2a: Lock-Besitz wird künftig über die stabile,
-- eindeutige `user_id` verglichen statt über den nicht-eindeutigen
-- Anzeigenamen (zwei Nutzer mit demselben OIDC-`name`-Claim konnten sich
-- sonst gegenseitig Locks übernehmen/löschen). Die neue Spalte ist NOT NULL
-- (kein Default) — bestehende Zeilen werden vorab gelöscht, statt sie mit
-- einem Platzhalter-Wert zu befüllen: Locks sind laut README/Spec flüchtige
-- Betriebsdaten (Soft-Lock, 2-Minuten-TTL, reiner Hinweis-Charakter, siehe
-- `src/drafts/lifecycle.ts#LOCK_TTL_MS`) — ihr Verlust bei einem Deploy ist
-- folgenlos, ein Nutzer heartbeatet den Lock ohnehin binnen Sekunden neu.
DELETE FROM "locks";--> statement-breakpoint
ALTER TABLE "locks" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "locks" ADD CONSTRAINT "locks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;