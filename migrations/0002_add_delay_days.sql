ALTER TABLE `sequence_steps` ADD `delay_days` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Carry existing values across rather than resetting them to the new default.
-- 0 minutes stays 0 (send immediately); anything else rounds up to a whole day,
-- so a sub-day delay becomes 1 rather than silently becoming 0.
UPDATE `sequence_steps`
SET `delay_days` = CASE
  WHEN `delay_minutes` <= 0 THEN 0
  ELSE MAX(1, CAST((`delay_minutes` + 1439) / 1440 AS INTEGER))
END;
