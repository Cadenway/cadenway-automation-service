CREATE TABLE "automation_runs" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_author_user_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"action" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp (3) with time zone,
	CONSTRAINT "automation_runs_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "automation_runs_action_object_check" CHECK (jsonb_typeof("automation_runs"."action") = 'object'),
	CONSTRAINT "automation_runs_status_check" CHECK ("automation_runs"."status" in ('pending', 'applied', 'no_op')),
	CONSTRAINT "automation_runs_execution_time_check" CHECK (("automation_runs"."status" = 'applied') = ("automation_runs"."executed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "rule_author_user_id" uuid NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_organization_rule_event_unique" ON "automation_runs" USING btree ("organization_id","rule_id","source_event_id");--> statement-breakpoint
CREATE INDEX "automation_runs_organization_executed_id_index" ON "automation_runs" USING btree ("organization_id","executed_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "automation_runs"."status" = 'applied';--> statement-breakpoint
CREATE POLICY "automation_runs_tenant_isolation" ON "automation_runs" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');
--> statement-breakpoint
ALTER TABLE "automation_runs" FORCE ROW LEVEL SECURITY;
