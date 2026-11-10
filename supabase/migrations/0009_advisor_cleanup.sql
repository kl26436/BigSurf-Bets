-- Clean-up after Supabase's security advisor was run against 0006/0007.
--
--   bsb.touch_updated_at   had no fixed search_path
--   pg_net                 was registered in `public` (0007 created it without naming a schema);
--                          Supabase keeps extensions in `extensions`. Its functions live in `net` either way.
--
-- Left as they are, on purpose: four tables with row-level security and no policy
-- (app_users, app_config, schema_migrations, user_settings: reached only through functions), and
-- the public.bsb_* functions being SECURITY DEFINER and callable by signed-in users (each one
-- checks membership itself; bsb_whoami and bsb_claim_owner are meant for any signed-in account).

begin;

alter function bsb.touch_updated_at() set search_path = '';

do $$
begin
    if exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
               where e.extname = 'pg_net' and n.nspname = 'public')
       and exists (select 1 from pg_namespace where nspname = 'extensions') then
        begin
            execute 'drop extension pg_net';
            execute 'create extension pg_net with schema extensions';
        exception when others then
            raise warning 'pg_net left where it is: %', sqlerrm;
        end;
    end if;
end $$;

commit;
