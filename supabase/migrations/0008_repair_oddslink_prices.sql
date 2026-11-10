-- One-off data repair.
--
-- OddsLink quotes American odds. The first ingest only converted the negative
-- ones, so every plus-money price was stored as if it were a decimal price:
-- +145 became decimal 145.0 (a 144-to-1 shot). 480 of 2,610 rows were affected,
-- including every underdog moneyline. The quoted number survives intact in
-- price_decimal, so the repair is exact:  decimal = 1 + american / 100.
--
-- bsb.line_quotes is derived from those rows (and had to throw most moneyline
-- markets away as "incoherent"), so the analyses of the affected snapshots are
-- removed; the next `bsb edges lines` / projections run rebuilds from good prices.

begin;

update bsb.odds_snapshots
   set price_american = round(price_decimal)::int,
       price_decimal  = round(1 + price_decimal / 100, 4),
       raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('quoted', price_decimal, 'repaired', '0008')
 where provider = 'oddslink' and price_decimal >= 100;

delete from bsb.line_quotes q
 where q.captured_at <= (select max(captured_at) from bsb.odds_snapshots
                         where provider = 'oddslink' and raw ? 'repaired');

commit;
