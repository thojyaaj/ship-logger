CREATE TABLE `app_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pin_hash` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `box` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`box_number` integer NOT NULL,
	`ups_tracking` text,
	FOREIGN KEY (`session_id`) REFERENCES `shipment_session`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `box_session_number_idx` ON `box` (`session_id`,`box_number`);--> statement-breakpoint
CREATE TABLE `scan` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`box_id` text,
	`scanned_by` text NOT NULL,
	`tracking_number` text NOT NULL,
	`carrier` text NOT NULL,
	`scanned_at` text DEFAULT (current_timestamp) NOT NULL,
	`sequence` integer NOT NULL,
	`order_gid` text,
	`order_name` text,
	`epg_external_ref` text,
	`epg_final_mile` text,
	`status_code` text,
	`status_label` text,
	`status_at` text,
	`status_checked_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `shipment_session`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`box_id`) REFERENCES `box`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scanned_by`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_tracking_number_idx` ON `scan` (`tracking_number`);--> statement-breakpoint
CREATE TABLE `shipment_session` (
	`id` text PRIMARY KEY NOT NULL,
	`opened_at` text DEFAULT (current_timestamp) NOT NULL,
	`opened_by` text NOT NULL,
	`submitted_at` text,
	`submitted_by` text,
	`ship_date` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`awb_number` text,
	`master_ups_tracking` text,
	FOREIGN KEY (`opened_by`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_by`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
