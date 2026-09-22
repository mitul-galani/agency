ALTER TABLE `ideas` ADD `parked_at` text;--> statement-breakpoint
ALTER TABLE `ideas` ADD `parked_until` text;--> statement-breakpoint
ALTER TABLE `ideas` ADD `parked_note` text DEFAULT '' NOT NULL;