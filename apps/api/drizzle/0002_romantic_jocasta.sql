ALTER TABLE "edges" DROP CONSTRAINT "edges_from_page_id_pages_id_fk";
--> statement-breakpoint
ALTER TABLE "edges" DROP CONSTRAINT "edges_to_page_id_pages_id_fk";
--> statement-breakpoint
ALTER TABLE "locks" DROP CONSTRAINT "locks_page_id_pages_id_fk";
--> statement-breakpoint
ALTER TABLE "tags" DROP CONSTRAINT "tags_page_id_pages_id_fk";
--> statement-breakpoint
-- Alter PK-Name folgt Postgres' Default-Konvention ("<table>_pkey") für die
-- inline "id text PRIMARY KEY" aus Migration 0000 — von drizzle-kit nicht
-- automatisch erkennbar (siehe Tool-Hinweis), daher von Hand ergänzt.
ALTER TABLE "pages" DROP CONSTRAINT "pages_pkey";--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_id_ref_pk" PRIMARY KEY("id","ref");--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "ref" text DEFAULT 'main';--> statement-breakpoint
ALTER TABLE "locks" ADD COLUMN "ref" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "ref" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_from_page_id_ref_pages_id_ref_fk" FOREIGN KEY ("from_page_id","ref") REFERENCES "public"."pages"("id","ref") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_to_page_id_ref_pages_id_ref_fk" FOREIGN KEY ("to_page_id","ref") REFERENCES "public"."pages"("id","ref") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locks" ADD CONSTRAINT "locks_page_id_ref_pages_id_ref_fk" FOREIGN KEY ("page_id","ref") REFERENCES "public"."pages"("id","ref") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_page_id_ref_pages_id_ref_fk" FOREIGN KEY ("page_id","ref") REFERENCES "public"."pages"("id","ref") ON DELETE cascade ON UPDATE no action;