-- ════════════════════════════════════════════════════════════════
--  StudyVerse — Supabase setup / repair script
--  Project: ftingspmkdrdkddsdgtv
--
--  Run this in: Supabase Dashboard → SQL Editor → New Query → Run
--  It is SAFE TO RE-RUN (idempotent) if something fails partway.
--
--  This fixes:
--   1) Uploaded files/resources not being visible to other users
--      (missing public SELECT policy + private storage bucket)
--   2) Group chat only working locally (no shared table existed)
--   3) Adds avatar_url support for the new Settings page
--   4) "Could not find the 'description' column of 'resources' in the
--      schema cache" — self-heals a pre-existing resources/chat_messages
--      table that's missing columns, and forces PostgREST to reload its
--      schema cache immediately
-- ════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────
-- 0. Extensions needed for gen_random_uuid()
-- ───────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;

-- ───────────────────────────────────────────────────────────────
-- 1. PROFILES  (created by your handle_new_user trigger already —
--    we just make sure the columns the app needs exist)
-- ───────────────────────────────────────────────────────────────
alter table if exists public.profiles
  add column if not exists name text,
  add column if not exists avatar_url text,
  add column if not exists is_admin boolean default false,
  add column if not exists updated_at timestamptz default now();

alter table public.profiles enable row level security;

drop policy if exists "Profiles are publicly readable" on public.profiles;
create policy "Profiles are publicly readable"
  on public.profiles for select
  to anon, authenticated
  using (true);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ───────────────────────────────────────────────────────────────
-- 2. RESOURCES  (the table your uploads are stored in)
-- ───────────────────────────────────────────────────────────────
create table if not exists public.resources (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  subject        text not null,
  topic          text default 'General',
  description    text default '',
  file_url       text,
  file_name      text,
  file_size      bigint,
  url            text,
  body           text,
  type           text default 'article',
  source_type    text default 'file',
  uploaded_by    uuid references auth.users(id) on delete set null,
  uploader_email text,
  uploader_name  text,
  created_at     timestamptz default now()
);

-- ⚠️ If `resources` already existed in your project from an earlier
--    version of the app, the `create table if not exists` above does
--    NOTHING to it — it will NOT add columns that were introduced later
--    (like `description`). That mismatch is what causes errors such as
--    "Could not find the 'description' column of 'resources' in the
--    schema cache". This block makes sure every column the app needs
--    actually exists, whether the table is brand new or years old.
alter table if exists public.resources
  add column if not exists topic          text default 'General',
  add column if not exists description    text default '',
  add column if not exists file_url       text,
  add column if not exists file_name      text,
  add column if not exists file_size      bigint,
  add column if not exists url            text,
  add column if not exists body           text,
  add column if not exists type           text default 'article',
  add column if not exists source_type    text default 'file',
  add column if not exists uploaded_by    uuid references auth.users(id) on delete set null,
  add column if not exists uploader_email text,
  add column if not exists uploader_name  text,
  add column if not exists created_at     timestamptz default now();

alter table public.resources enable row level security;

-- Anyone (including logged-out visitors) can READ every resource.
-- ⚠️ This was almost certainly the cause of "files not visible to
--    other users" — without this policy, RLS silently returns 0 rows
--    to anyone who isn't the uploader.
drop policy if exists "Resources are publicly readable" on public.resources;
create policy "Resources are publicly readable"
  on public.resources for select
  to anon, authenticated
  using (true);

-- Only logged-in users can create resources, and only as themselves.
drop policy if exists "Authenticated users can insert their own resources" on public.resources;
create policy "Authenticated users can insert their own resources"
  on public.resources for insert
  to authenticated
  with check (auth.uid() = uploaded_by);

-- Owners (or admins) can update/delete their own resources.
drop policy if exists "Owners can update their resources" on public.resources;
create policy "Owners can update their resources"
  on public.resources for update
  to authenticated
  using (auth.uid() = uploaded_by or exists (
           select 1 from public.profiles p where p.id = auth.uid() and p.is_admin
         ))
  with check (auth.uid() = uploaded_by or exists (
           select 1 from public.profiles p where p.id = auth.uid() and p.is_admin
         ));

drop policy if exists "Owners can delete their resources" on public.resources;
create policy "Owners can delete their resources"
  on public.resources for delete
  to authenticated
  using (auth.uid() = uploaded_by or exists (
           select 1 from public.profiles p where p.id = auth.uid() and p.is_admin
         ));

-- ───────────────────────────────────────────────────────────────
-- 3. CHAT_MESSAGES  (new table — group chat previously only used
--    localStorage, so nobody actually shared a conversation)
-- ───────────────────────────────────────────────────────────────
create table if not exists public.chat_messages (
  id          uuid primary key default gen_random_uuid(),
  author_name text not null,
  text        text not null,
  user_id     uuid references auth.users(id) on delete set null,
  created_at  timestamptz default now()
);

-- Same self-healing as above, in case this table already existed
-- with a different shape.
alter table if exists public.chat_messages
  add column if not exists user_id    uuid references auth.users(id) on delete set null,
  add column if not exists created_at timestamptz default now();

alter table public.chat_messages enable row level security;

drop policy if exists "Chat messages are publicly readable" on public.chat_messages;
create policy "Chat messages are publicly readable"
  on public.chat_messages for select
  to anon, authenticated
  using (true);

drop policy if exists "Authenticated users can send chat messages" on public.chat_messages;
create policy "Authenticated users can send chat messages"
  on public.chat_messages for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Turn on Realtime replication for the chat table so messages appear
-- live for everyone (Database → Replication also works from the UI).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────
-- 4. STORAGE BUCKETS  (public read is required for shared file
--    downloads and for avatars to render for other users)
-- ───────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('resources', 'resources', true)
on conflict (id) do update set public = true;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

-- Public read for both buckets
drop policy if exists "Public read - resources bucket" on storage.objects;
create policy "Public read - resources bucket"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'resources');

drop policy if exists "Public read - avatars bucket" on storage.objects;
create policy "Public read - avatars bucket"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'avatars');

-- Only logged-in users can upload
drop policy if exists "Authenticated upload - resources bucket" on storage.objects;
create policy "Authenticated upload - resources bucket"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'resources');

drop policy if exists "Authenticated upload - avatars bucket" on storage.objects;
create policy "Authenticated upload - avatars bucket"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'avatars');

-- Owners can delete/replace their own uploaded files
drop policy if exists "Owner delete - resources bucket" on storage.objects;
create policy "Owner delete - resources bucket"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'resources' and owner = auth.uid());

drop policy if exists "Owner update - avatars bucket" on storage.objects;
create policy "Owner update - avatars bucket"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'avatars' and owner = auth.uid());

-- ───────────────────────────────────────────────────────────────
-- 5. FORCE POSTGREST TO RELOAD ITS SCHEMA CACHE
--    PostgREST (the API layer Supabase's JS client talks to) caches
--    the table/column list. After ALTERing tables above, that cache
--    can be stale for a few minutes and you'll see errors like
--    "Could not find the 'description' column of 'resources' in the
--    schema cache" even though the column now exists. This forces an
--    immediate reload so the fix takes effect right away.
-- ───────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════
--  Done. After running this:
--   • Any file/link/text a user uploads is visible to everyone.
--   • The group chat is shared and persists for everyone.
--   • Avatars uploaded from the new Settings page are public.
-- ════════════════════════════════════════════════════════════════
