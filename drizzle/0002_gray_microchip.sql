CREATE TABLE `modpack` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`image_url` text,
	`owner` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`owner`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `modpack_slug_unique` ON `modpack` (`slug`);--> statement-breakpoint
CREATE TABLE `modpack_version` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`mod_configs_url` text,
	`mods_string` text,
	`downloads` integer DEFAULT 0 NOT NULL,
	`image_url` text,
	`modpack` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`modpack`) REFERENCES `modpack`(`id`) ON UPDATE no action ON DELETE cascade
);
