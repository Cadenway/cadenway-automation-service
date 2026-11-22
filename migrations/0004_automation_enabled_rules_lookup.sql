CREATE INDEX IF NOT EXISTS "automation_rules_enabled_organization_created_id_index" ON "automation_rules" USING btree ("organization_id","created_at","id") WHERE "automation_rules"."enabled";
