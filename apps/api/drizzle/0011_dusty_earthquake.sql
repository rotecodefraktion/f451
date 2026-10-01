CREATE TABLE "page_releases" (
	"page_id" text NOT NULL,
	"space_id" text NOT NULL,
	"version" text NOT NULL,
	"major" integer NOT NULL,
	"minor" integer NOT NULL,
	"patch" integer NOT NULL,
	"path" text NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	"author" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"blob_sha" text NOT NULL,
	"tampered" boolean DEFAULT false NOT NULL,
	CONSTRAINT "page_releases_page_id_version_pk" PRIMARY KEY("page_id","version")
);
--> statement-breakpoint
ALTER TABLE "page_releases" ADD CONSTRAINT "page_releases_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;