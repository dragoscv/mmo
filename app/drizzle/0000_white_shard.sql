CREATE TABLE `account` (
	`userId` text NOT NULL,
	`type` text NOT NULL,
	`provider` text NOT NULL,
	`providerAccountId` text NOT NULL,
	`refresh_token` text,
	`access_token` text,
	`expires_at` integer,
	`token_type` text,
	`scope` text,
	`id_token` text,
	`session_state` text,
	PRIMARY KEY(`provider`, `providerAccountId`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `analysis_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`track_id` integer NOT NULL,
	`track_artist` text NOT NULL,
	`track_title` text NOT NULL,
	`field` text NOT NULL,
	`field_label` text NOT NULL,
	`old_value` text,
	`new_value` text NOT NULL,
	`source` text NOT NULL,
	`checked` integer DEFAULT false
);
--> statement-breakpoint
CREATE TABLE `analysis_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`mode` text NOT NULL,
	`options` text NOT NULL,
	`progress` integer DEFAULT 0,
	`total` integer DEFAULT 0,
	`current_track` text,
	`changes_count` integer DEFAULT 0,
	`errors_count` integer DEFAULT 0,
	`errors` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `device_folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`path` text NOT NULL,
	`label` text,
	`track_count` integer DEFAULT 0,
	`total_size` integer DEFAULT 0,
	`last_scanned_at` text,
	`is_enabled` integer DEFAULT true,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`os` text,
	`hostname` text,
	`api_url` text NOT NULL,
	`token` text NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`last_seen_at` text,
	`version` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `downloads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`artist` text,
	`duration` integer,
	`thumbnail` text,
	`extractor` text,
	`file_path` text,
	`file_size` integer,
	`format` text,
	`quality` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`track_id` integer,
	`error` text,
	`downloaded_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `drives` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`label` text,
	`type` text NOT NULL,
	`format` text,
	`is_active` integer DEFAULT true,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drives_path_unique` ON `drives` (`path`);--> statement-breakpoint
CREATE TABLE `offline_tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`track_id` integer NOT NULL,
	`device_id` text,
	`cached_at` text DEFAULT (datetime('now')),
	`size` integer NOT NULL,
	`priority` integer DEFAULT 0,
	`is_pinned` integer DEFAULT false,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `playlist_tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer,
	`track_id` integer,
	`position` integer NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'manual',
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`source` text NOT NULL,
	`name` text NOT NULL,
	`filepath` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`metadata` text,
	`notes` text,
	`is_favorite` integer DEFAULT false,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scan_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`filepath` text NOT NULL,
	`details` text,
	`scanned_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `session` (
	`sessionToken` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filepath` text NOT NULL,
	`filename` text NOT NULL,
	`artist` text,
	`title` text,
	`album` text,
	`remix` text,
	`label` text,
	`bpm` real,
	`key_camelot` text,
	`key_musical` text,
	`duration` integer,
	`energy` integer,
	`genre` text,
	`subgenre` text,
	`mood` text,
	`color` text,
	`vocal_type` text,
	`set_position` text,
	`mixability` integer,
	`is_processed` integer DEFAULT false,
	`file_size` integer,
	`format` text,
	`bitrate` integer,
	`sample_rate` integer,
	`added_at` text DEFAULT (datetime('now')),
	`analyzed_at` text,
	`rating` integer,
	`is_favorite` integer DEFAULT false,
	`tags` text,
	`artwork_url` text,
	`musicbrainz_id` text,
	`release_mbid` text,
	`isrc` text,
	`year` integer,
	`comment` text,
	`lyrics` text,
	`synced_lyrics` text,
	`is_hidden` integer DEFAULT false,
	`source_url` text,
	`source_platform` text,
	`source_id` text,
	`related_track_id` integer,
	`device_id` text,
	`is_offline_available` integer DEFAULT false,
	`stems_status` text,
	`stems_vocals_path` text,
	`stems_drums_path` text,
	`stems_bass_path` text,
	`stems_melody_path` text,
	`stems_analyzed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracks_filepath_unique` ON `tracks` (`filepath`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`email` text,
	`emailVerified` integer,
	`image` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verificationToken` (
	`identifier` text NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`identifier`, `token`)
);
