-- Blink Reader: database setup for syncing your library across devices.
--
-- Run this once in your Supabase project: open SQL Editor, paste the whole
-- file, and click Run. It is safe to run again.
--
-- Each signed-in person can only see and change their own rows; the
-- row-level security policies at the bottom enforce that on the server.

create table if not exists public.books (
  user_id       uuid    not null default auth.uid() references auth.users (id) on delete cascade,
  id            text    not null,
  title         text    not null default '',
  author        text    not null default '',
  source        text    not null default '',
  file_name     text    not null default '',
  file_size     bigint  not null default 0,
  word_count    integer not null default 0,
  page_starts   jsonb   not null default '[]'::jsonb,
  chapters      jsonb   not null default '[]'::jsonb,
  position      integer not null default 0,
  added_at      bigint  not null default 0,
  opened_at     bigint  not null default 0,
  updated_at    bigint  not null default 0,
  time_spent_ms bigint  not null default 0,
  words_read    bigint  not null default 0,
  finished_at   bigint,
  deleted       boolean not null default false,
  primary key (user_id, id)
);

-- A book's text, split into numbered pieces so large books fit in one request each.
create table if not exists public.book_texts (
  user_id uuid    not null default auth.uid() references auth.users (id) on delete cascade,
  book_id text    not null,
  n       integer not null,
  text    text    not null,
  primary key (user_id, book_id, n)
);

alter table public.books enable row level security;
alter table public.book_texts enable row level security;

drop policy if exists "Own books only" on public.books;
create policy "Own books only" on public.books
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Own book text only" on public.book_texts;
create policy "Own book text only" on public.book_texts
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.books to authenticated;
grant select, insert, update, delete on public.book_texts to authenticated;
