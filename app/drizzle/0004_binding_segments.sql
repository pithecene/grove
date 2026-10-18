DROP INDEX `idx_bindings_identity_name`;--> statement-breakpoint
CREATE INDEX `idx_bindings_identity` ON `repository_bindings` (`github_id`,`full_name`);--> statement-breakpoint
ALTER TABLE `climate_proposals` ADD `source_repositories` text;