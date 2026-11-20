CREATE TABLE `attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attempts_expires` ON `attempts` (`expires_at`);--> statement-breakpoint
ALTER TABLE `delegated_tokens` ADD `minted_with` text;--> statement-breakpoint
ALTER TABLE `delegated_tokens` ADD `revoked_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `opened_with` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_agent` text;--> statement-breakpoint
-- Written by hand. A session from before this migration has no record of the
-- token that opened it, and would outlive that token's revocation by up to
-- thirty days. Which token it was can't be recovered, so they all end here:
-- everyone signs in once more.
DELETE FROM `sessions`;--> statement-breakpoint
CREATE INDEX `sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `service_tokens_service` ON `service_tokens` (`service_id`);--> statement-breakpoint
CREATE INDEX `tokens_user` ON `tokens` (`user_id`);