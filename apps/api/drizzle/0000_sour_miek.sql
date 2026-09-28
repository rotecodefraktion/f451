CREATE TABLE "edges" (
	"from_page_id" text NOT NULL,
	"to_page_id" text,
	"raw_target" text NOT NULL,
	"type" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	CONSTRAINT "edges_from_page_id_raw_target_type_label_pk" PRIMARY KEY("from_page_id","raw_target","type","label")
);
--> statement-breakpoint
CREATE TABLE "locks" (
	"page_id" text PRIMARY KEY NOT NULL,
	"user_name" text NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"path" text NOT NULL,
	"ref" text NOT NULL,
	"title" text NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"frontmatter_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"headings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plain_text" text DEFAULT '' NOT NULL,
	"html_rendered" text DEFAULT '' NOT NULL,
	"lang" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"error_status" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector"
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"name" text NOT NULL,
	"default_lang" text NOT NULL,
	"indexed_head_sha" text
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"page_id" text NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "tags_page_id_tag_pk" PRIMARY KEY("page_id","tag")
);
--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_from_page_id_pages_id_fk" FOREIGN KEY ("from_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_to_page_id_pages_id_fk" FOREIGN KEY ("to_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locks" ADD CONSTRAINT "locks_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pages_space_path_ref_unique" ON "pages" USING btree ("space_id","path","ref");--> statement-breakpoint
CREATE INDEX "pages_search_vector_gin" ON "pages" USING gin ("search_vector");