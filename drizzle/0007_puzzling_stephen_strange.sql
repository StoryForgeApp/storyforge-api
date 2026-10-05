CREATE TABLE `moddb_file` (
	`file_id` integer PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`filename` text NOT NULL,
	`size` integer,
	`sha256` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`verified_at` integer,
	`last_attempt_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `modpack_file` (
	`id` text PRIMARY KEY NOT NULL,
	`modpack_version` text NOT NULL,
	`mod_id` integer NOT NULL,
	`mod_id_str` text NOT NULL,
	`name` text NOT NULL,
	`mod_version` text NOT NULL,
	`release_id` integer,
	`file_id` integer NOT NULL,
	`filename` text NOT NULL,
	`url` text NOT NULL,
	`sha256` text,
	`size` integer,
	`side` text DEFAULT 'both' NOT NULL,
	`required` integer DEFAULT true NOT NULL,
	`game_versions` text,
	`compatible` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`modpack_version`) REFERENCES `modpack_version`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `modpack_file_version_mod_uidx` ON `modpack_file` (`modpack_version`,`mod_id`);--> statement-breakpoint
CREATE INDEX `modpack_file_version_idx` ON `modpack_file` (`modpack_version`);--> statement-breakpoint
CREATE INDEX `modpack_file_modId_idx` ON `modpack_file` (`mod_id`);--> statement-breakpoint
CREATE INDEX `modpack_file_fileId_idx` ON `modpack_file` (`file_id`);--> statement-breakpoint
ALTER TABLE `modpack_version` ADD `manifest_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `modpack_version` ADD `manifest_hash` text;--> statement-breakpoint
ALTER TABLE `modpack_version` ADD `changelog` text;--> statement-breakpoint
ALTER TABLE `modpack_version` ADD `mod_configs_sha256` text;--> statement-breakpoint
ALTER TABLE `modpack_version` ADD `mod_configs_size` integer;