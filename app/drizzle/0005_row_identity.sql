ALTER TABLE `declaration_changes` ADD `github_id` integer;--> statement-breakpoint
CREATE INDEX `idx_declarations_identity_time` ON `declaration_changes` (`github_id`,`observed_at`);--> statement-breakpoint
ALTER TABLE `ecology_snapshots` ADD `github_id` integer;--> statement-breakpoint
CREATE INDEX `idx_snapshots_identity_time` ON `ecology_snapshots` (`github_id`,`observed_at`);