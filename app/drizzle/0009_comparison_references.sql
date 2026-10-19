CREATE TABLE `comparison_references` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`steward_id` integer NOT NULL,
	`reference_at` text NOT NULL,
	`saved_at` text NOT NULL,
	`label` text
);
