CREATE TABLE `actors` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`principal` text NOT NULL,
	`profile` text,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actors_team_handle` ON `actors` (`team_id`,`handle`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`vibe_id` text NOT NULL,
	`uploader` text NOT NULL,
	`uploaded_by` text,
	`blob_key` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`vibe_id` text NOT NULL,
	`path` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`vibe_id`, `path`)
);
--> statement-breakpoint
CREATE TABLE `delegated_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`principal` text NOT NULL,
	`vibe_id` text NOT NULL,
	`profile` text NOT NULL,
	`can` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delegated_tokens_hash_unique` ON `delegated_tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `delegated_tokens_principal` ON `delegated_tokens` (`principal`,`expires_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vibe_id` text NOT NULL,
	`type` text NOT NULL,
	`channel` text,
	`thread_id` text,
	`thread_version` integer,
	`message_id` text,
	`actor_id` text NOT NULL,
	`payload` text NOT NULL,
	`facets` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_thread_version` ON `events` (`thread_id`,`thread_version`);--> statement-breakpoint
CREATE INDEX `events_vibe_seq` ON `events` (`vibe_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_message` ON `events` (`message_id`);--> statement-breakpoint
CREATE TABLE `grants` (
	`vibe_id` text NOT NULL,
	`n` integer NOT NULL,
	`principals` text NOT NULL,
	`can` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	PRIMARY KEY(`vibe_id`, `n`)
);
--> statement-breakpoint
CREATE TABLE `idempotency` (
	`principal` text NOT NULL,
	`key` text NOT NULL,
	`target` text NOT NULL,
	`message_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`principal`, `key`)
);
--> statement-breakpoint
CREATE TABLE `mentions` (
	`message_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`thread_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `actor_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mentions_thread` ON `mentions` (`thread_id`,`actor_id`);--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`attachment_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `message_attachments_message` ON `message_attachments` (`message_id`);--> statement-breakpoint
CREATE TABLE `message_labels` (
	`message_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`message_id`, `key`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `message_labels_thread` ON `message_labels` (`thread_id`,`key`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`vibe_id` text NOT NULL,
	`reply_to` text,
	`actor_id` text NOT NULL,
	`text` text NOT NULL,
	`position` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	`blocks` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_thread_position` ON `messages` (`thread_id`,`position`);--> statement-breakpoint
CREATE INDEX `messages_vibe_actor` ON `messages` (`vibe_id`,`actor_id`,`thread_id`);--> statement-breakpoint
CREATE TABLE `policy_revisions` (
	`vibe_id` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`vibe_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `reactions` (
	`message_id` text NOT NULL,
	`emoji` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `emoji`, `actor_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`vibe_id` text NOT NULL,
	`channel` text NOT NULL,
	`thread_id` text,
	`reply_to` text,
	`actor_id` text NOT NULL,
	`principal` text NOT NULL,
	`profile` text,
	`text` text NOT NULL,
	`labels` text NOT NULL,
	`blocks` text NOT NULL,
	`state` text NOT NULL,
	`next_at` integer NOT NULL,
	`every` integer,
	`until` integer,
	`remaining` integer,
	`runs` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`last_message_id` text,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `schedules_due` ON `schedules` (`state`,`next_at`);--> statement-breakpoint
CREATE INDEX `schedules_vibe` ON `schedules` (`vibe_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `schedules_thread` ON `schedules` (`thread_id`);--> statement-breakpoint
CREATE TABLE `schemas` (
	`team_id` text NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`description` text,
	`definition` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`team_id`, `name`, `version`)
);
--> statement-breakpoint
CREATE TABLE `service_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`service_id` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_tokens_hash_unique` ON `service_tokens` (`hash`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `services_team_name` ON `services` (`team_id`,`name`);--> statement-breakpoint
CREATE TABLE `task_needs` (
	`task_id` text NOT NULL,
	`needs_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `needs_id`)
);
--> statement-breakpoint
CREATE INDEX `task_needs_needed` ON `task_needs` (`needs_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`vibe_id` text NOT NULL,
	`channel` text NOT NULL,
	`owner` text NOT NULL,
	`owner_principal` text NOT NULL,
	`state` text NOT NULL,
	`assignee` text,
	`claim_id` text,
	`claimed_by` text,
	`lease_expires_at` integer,
	`hold_kind` text,
	`hold_reason` text,
	`result` text,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_queue` ON `tasks` (`vibe_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_lease` ON `tasks` (`state`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_name_unique` ON `teams` (`name`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`vibe_id` text NOT NULL,
	`channel` text NOT NULL,
	`version` integer NOT NULL,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`last_message_id` text NOT NULL,
	`last_activity_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `threads_recent` ON `threads` (`vibe_id`,`last_activity_at`);--> statement-breakpoint
CREATE INDEX `threads_channel` ON `threads` (`vibe_id`,`channel`,`last_activity_at`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`user_id` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_hash_unique` ON `tokens` (`hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`github_id` integer,
	`github_login` text,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_team_handle` ON `users` (`team_id`,`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_team_github` ON `users` (`team_id`,`github_id`);--> statement-breakpoint
CREATE INDEX `users_team_github_login` ON `users` (`team_id`,`github_login`);--> statement-breakpoint
CREATE TABLE `vibes` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vibes_team_name` ON `vibes` (`team_id`,`name`);--> statement-breakpoint
CREATE TABLE `watcher_cursors` (
	`watcher_id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`leased_until` integer,
	`last_status` integer,
	`last_error` text,
	`delivered_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `watchers` (
	`id` text PRIMARY KEY NOT NULL,
	`vibe_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`tail` text NOT NULL,
	`secret` text NOT NULL,
	`actor_id` text NOT NULL,
	`principal` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchers_vibe_name` ON `watchers` (`vibe_id`,`name`);