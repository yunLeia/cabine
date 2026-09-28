-- Product analytics for Cabine (docs/decisions.md D23). One row per event.
-- No photos, product titles or page URLs: only event names, a hashed install
-- id, and small properties (category, store domain, counts, timings).
create table if not exists events (
  id          bigserial primary key,
  user_hash   text        not null,               -- sha256 of the anonymous install id
  name        text        not null,               -- e.g. store_item_captured
  props       jsonb       not null default '{}',
  client_at   timestamptz not null,               -- when it happened (the extension's clock)
  received_at timestamptz not null default now()
);
create index if not exists events_name_time on events (name, client_at);
create index if not exists events_user_time on events (user_hash, client_at);
