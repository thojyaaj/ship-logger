ALTER TABLE "app_user" ADD COLUMN "packer_code" text;--> statement-breakpoint
UPDATE "app_user" AS u
SET "packer_code" = LPAD(sub.rn::text, 2, '0')
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn
  FROM "app_user"
) AS sub
WHERE u.id = sub.id;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_packer_code_unique" UNIQUE("packer_code");