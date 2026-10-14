CREATE TABLE "agent_outbox" (
	"computer_id" text NOT NULL,
	"seq" integer NOT NULL,
	"body" jsonb NOT NULL,
	"run_id" text,
	CONSTRAINT "agent_outbox_computer_id_seq_pk" PRIMARY KEY("computer_id","seq")
);
--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "up_stream" text;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "up_acked" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "down_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "down_applied" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "conn_gen" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_outbox" ADD CONSTRAINT "agent_outbox_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_outbox" ADD CONSTRAINT "agent_outbox_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_outbox_run_id_idx" ON "agent_outbox" USING btree ("run_id");