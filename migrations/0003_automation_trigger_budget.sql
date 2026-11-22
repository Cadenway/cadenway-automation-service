CREATE TABLE "automation_trigger_budget" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"queued_count" integer NOT NULL,
	CONSTRAINT "automation_trigger_budget_count_check" CHECK ("automation_trigger_budget"."queued_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "automation_trigger_budget" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "automation_trigger_budget_tenant_isolation" ON "automation_trigger_budget" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');
--> statement-breakpoint
ALTER TABLE "automation_trigger_budget" FORCE ROW LEVEL SECURITY;
