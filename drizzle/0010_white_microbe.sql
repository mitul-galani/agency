CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `context_items` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `context_items` (`id`, `text`, `position`)
SELECT 'legacy-context', `text`, 0
FROM `contexts`
WHERE `id` = (SELECT MAX(`id`) FROM `contexts`)
  AND trim(`text`) != ''
  AND NOT EXISTS (SELECT 1 FROM `context_items`);
--> statement-breakpoint
INSERT OR IGNORE INTO `app_meta` (`key`, `value`) VALUES ('context_items_migrated', '1');
