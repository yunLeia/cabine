-- Cabine product analytics (docs/decisions.md D23). Run them all with:
--   cd server && npm run report
-- Each query starts with a "-- name:" line.

-- name: Primary metric: store items combined with at least one closet piece
-- Of the store items captured (and saved), how many were rendered together with
-- something the person already owns?
with captured as (
  select distinct props->>'itemId' as item_id
  from events where name = 'store_item_captured' and (props->>'ok')::boolean
),
combined as (
  select distinct jsonb_array_elements_text(props->'candidateIds') as item_id
  from events where name = 'outfit_render_requested' and (props->>'fromCloset')::int >= 1
)
select count(*) as captured,
       count(*) filter (where item_id in (select item_id from combined)) as combined_with_closet,
       round(100.0 * count(*) filter (where item_id in (select item_id from combined)) / nullif(count(*), 0), 1) as pct
from captured;

-- name: Funnel (installs reaching each step)
with steps as (
  select user_hash,
         bool_or(name = 'store_item_captured')      as captured,
         bool_or(name = 'closet_item_selected')     as added_closet_piece,
         bool_or(name = 'outfit_render_requested')  as requested_outfit,
         bool_or(name = 'outfit_render_completed')  as viewed_render,
         bool_or(name like 'decision_%')            as made_decision
  from events group by user_hash
)
select count(*) filter (where captured)                                                  as "1 captured",
       count(*) filter (where captured and added_closet_piece)                           as "2 added closet piece",
       count(*) filter (where captured and added_closet_piece and requested_outfit)      as "3 requested outfit",
       count(*) filter (where captured and added_closet_piece and requested_outfit and viewed_render) as "4 viewed render",
       count(*) filter (where captured and added_closet_piece and requested_outfit and viewed_render and made_decision) as "5 made decision"
from steps;

-- name: Decisions
select replace(name, 'decision_', '') as decision, count(*) as n,
       round(100.0 * count(*) / sum(count(*)) over (), 1) as pct
from events where name like 'decision_%' group by name order by n desc;

-- name: Render speed and caching
select count(*) as renders,
       count(*) filter (where (props->>'cached')::boolean) as cached,
       round(percentile_cont(0.5) within group (order by (props->>'seconds')::numeric)::numeric, 1) as p50_seconds,
       round(percentile_cont(0.9) within group (order by (props->>'seconds')::numeric)::numeric, 1) as p90_seconds,
       (select count(*) from events where name = 'outfit_render_failed') as failed
from events where name = 'outfit_render_completed';

-- name: Captures by store (success rate)
select props->>'domain' as store, count(*) as captures,
       round(100.0 * count(*) filter (where (props->>'ok')::boolean) / count(*), 0) as ok_pct
from events where name = 'store_item_captured'
group by 1 order by captures desc limit 20;

-- name: Closet building (how pieces get into My Closet)
select coalesce(props->>'source', 'moved from Fitting Room') as source, count(*) as pieces
from events where name in ('closet_item_uploaded', 'item_moved_to_closet')
group by 1 order by pieces desc;

-- name: Photo clean-ups (1 credit each unless cached)
select count(*) filter (where name = 'photo_cleanup_requested') as requested,
       count(*) filter (where name = 'photo_cleanup_requested' and props->>'trigger' = 'auto') as automatic,
       count(*) filter (where name = 'photo_cleanup_completed') as completed,
       count(*) filter (where name = 'photo_cleanup_failed') as failed
from events;

-- name: Activity by day
select client_at::date as day, count(distinct user_hash) as installs, count(*) as events,
       count(*) filter (where name = 'outfit_render_requested') as outfits
from events group by 1 order by 1 desc limit 14;
