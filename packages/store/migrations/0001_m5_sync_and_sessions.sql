CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_hash_unique` ON `sessions` (`hash`);--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `sync_cursors` (
	`source_id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`leased_until` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_inbox` (
	`source_id` text NOT NULL,
	`delivery_id` text NOT NULL,
	`event` text NOT NULL,
	`body` text NOT NULL,
	`state` text NOT NULL,
	`note` text,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `delivery_id`)
);
--> statement-breakpoint
CREATE INDEX `sync_inbox_recent` ON `sync_inbox` (`source_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `sync_messages` (
	`sync_thread_id` text NOT NULL,
	`message_id` text NOT NULL,
	`source_id` text NOT NULL,
	`direction` text NOT NULL,
	`platform_message` text,
	`url` text,
	`state` text NOT NULL,
	`seq` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`sync_thread_id`, `message_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_messages_platform` ON `sync_messages` (`source_id`,`platform_message`);--> statement-breakpoint
CREATE INDEX `sync_messages_due` ON `sync_messages` (`source_id`,`state`,`seq`);--> statement-breakpoint
CREATE INDEX `sync_messages_message` ON `sync_messages` (`message_id`);--> statement-breakpoint
CREATE TABLE `sync_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`vibe_id` text NOT NULL,
	`key` text NOT NULL,
	`platform` text NOT NULL,
	`principal` text NOT NULL,
	`config` text NOT NULL,
	`credentials` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_sources_vibe_key` ON `sync_sources` (`vibe_id`,`key`);--> statement-breakpoint
CREATE TABLE `sync_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`vibe_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`platform_channel` text NOT NULL,
	`platform_thread` text,
	`url` text,
	`since_seq` integer NOT NULL,
	`state` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_threads_platform` ON `sync_threads` (`source_id`,`platform_thread`);--> statement-breakpoint
CREATE INDEX `sync_threads_thread` ON `sync_threads` (`thread_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `source` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `no_sync` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` ADD `no_sync` integer DEFAULT false NOT NULL;