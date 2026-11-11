-- The raw-JSON copies of three nflverse tables were read by nothing (no code, no
-- view) and took 367 MB of the 500 MB the free plan allows. nflverse itself is the
-- archive, and the model reads it directly. The ingest no longer writes them.
-- The space comes back after `vacuum full` on each table (cannot run in here:
-- it must be outside a transaction).
alter table bsb.player_week_stats drop column if exists raw;
alter table bsb.players           drop column if exists raw;
alter table bsb.injury_reports    drop column if exists raw;
