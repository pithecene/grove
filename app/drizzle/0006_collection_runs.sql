CREATE TABLE `collection_run_repositories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`github_id` integer,
	`full_name` text NOT NULL,
	`outcome` text NOT NULL,
	`answer` text,
	FOREIGN KEY (`run_id`) REFERENCES `collection_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_run_repositories_run` ON `collection_run_repositories` (`run_id`);--> statement-breakpoint
CREATE TABLE `collection_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`method` text NOT NULL,
	`steward_id` integer,
	`full_portfolio` integer NOT NULL,
	`complete` integer DEFAULT false NOT NULL,
	`answer` text,
	`scope` text
);
