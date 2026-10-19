ALTER TABLE `declaration_changes` ADD `method` text DEFAULT 'observed' NOT NULL;--> statement-breakpoint
ALTER TABLE `declaration_changes` ADD `recorded_at` text;--> statement-breakpoint
ALTER TABLE `declaration_changes` ADD `collection_run_id` integer;--> statement-breakpoint
ALTER TABLE `declaration_changes` ADD `evidence` text;--> statement-breakpoint
ALTER TABLE `ecology_snapshots` ADD `method` text DEFAULT 'observed' NOT NULL;--> statement-breakpoint
ALTER TABLE `ecology_snapshots` ADD `recorded_at` text;--> statement-breakpoint
ALTER TABLE `ecology_snapshots` ADD `collection_run_id` integer;--> statement-breakpoint
ALTER TABLE `ecology_snapshots` ADD `evidence` text;