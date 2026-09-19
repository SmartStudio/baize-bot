CREATE TABLE "tool_connection_bots" (
	"tool_connection_id" text NOT NULL,
	"bot_id" text NOT NULL,
	CONSTRAINT "tool_connection_bots_tool_connection_id_bot_id_pk" PRIMARY KEY("tool_connection_id","bot_id")
);
--> statement-breakpoint
CREATE TABLE "tool_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"authorization_enc" text,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_connection_bots" ADD CONSTRAINT "tool_connection_bots_tool_connection_id_tool_connections_id_fk" FOREIGN KEY ("tool_connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_connection_bots" ADD CONSTRAINT "tool_connection_bots_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_connection_bots_bot_id_idx" ON "tool_connection_bots" USING btree ("bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_connections_owner_id_name_idx" ON "tool_connections" USING btree ("owner_id","name");