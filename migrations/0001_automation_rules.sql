CREATE TABLE "automation_rules" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"trigger" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_rules_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "automation_rules_version_check" CHECK ("automation_rules"."version" between 1 and 9007199254740991),
	CONSTRAINT "automation_rules_trigger_object_check" CHECK (jsonb_typeof("automation_rules"."trigger") = 'object'),
	CONSTRAINT "automation_rules_action_object_check" CHECK (jsonb_typeof("automation_rules"."action") = 'object')
);
--> statement-breakpoint
ALTER TABLE "automation_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "automation_rules_organization_created_id_index" ON "automation_rules" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE POLICY "automation_rules_tenant_isolation" ON "automation_rules" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
ALTER TABLE "automation_rules" FORCE ROW LEVEL SECURITY;
