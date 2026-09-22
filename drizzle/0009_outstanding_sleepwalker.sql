CREATE TABLE `discovery_status` (
	`id` integer PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'idle' NOT NULL,
	`run_id` text DEFAULT '' NOT NULL,
	`started_at` text,
	`last_finished_at` text,
	`last_result` text DEFAULT '' NOT NULL,
	`schedule_minute` integer,
	`schedule_start_hour` integer,
	`schedule_end_hour` integer,
	`schedule_time_zone` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
