CREATE TABLE `identity_resolutions` (
	`full_name` text PRIMARY KEY NOT NULL,
	`attempted_at` text NOT NULL,
	`outcome` text NOT NULL,
	`http_status` integer,
	`github_id` integer,
	`resolved_full_name` text,
	`evidence` text,
	FOREIGN KEY (`full_name`) REFERENCES `repositories`(`full_name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `repository_bindings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_id` integer NOT NULL,
	`full_name` text NOT NULL,
	`first_observed_at` text NOT NULL,
	`last_observed_at` text NOT NULL,
	`method` text NOT NULL,
	`resolved_at` text NOT NULL,
	`evidence` text,
	FOREIGN KEY (`full_name`) REFERENCES `repositories`(`full_name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_bindings_identity_name` ON `repository_bindings` (`github_id`,`full_name`);--> statement-breakpoint
CREATE INDEX `idx_bindings_name` ON `repository_bindings` (`full_name`);--> statement-breakpoint
ALTER TABLE `climate_proposals` ADD `last_supported_at` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `github_id` integer;