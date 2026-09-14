CREATE TABLE "login_attempt" (
	"ip" text PRIMARY KEY NOT NULL,
	"window_count" integer NOT NULL,
	"window_start" text NOT NULL,
	"cumulative_failures" integer NOT NULL,
	"locked_until" text
);
