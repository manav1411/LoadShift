-- Run this file in Supabase SQL Editor before using the dashboard.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

revoke all on table public.profiles from anon;
grant select, insert, update on table public.profiles to authenticated;

drop policy if exists "Users can view their own profile" on public.profiles;
create policy "Users can view their own profile"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "Users can create their own profile" on public.profiles;
create policy "Users can create their own profile"
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create table if not exists public.workloads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  provider text,
  status text not null default 'Not configured',
  created_at timestamptz not null default now()
);

create index if not exists workloads_user_id_idx on public.workloads(user_id);
alter table public.workloads enable row level security;

revoke all on table public.workloads from anon;
grant select, insert, update, delete on table public.workloads to authenticated;

drop policy if exists "Users can view their own workloads" on public.workloads;
create policy "Users can view their own workloads"
  on public.workloads for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own workloads" on public.workloads;
create policy "Users can create their own workloads"
  on public.workloads for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own workloads" on public.workloads;
create policy "Users can update their own workloads"
  on public.workloads for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own workloads" on public.workloads;
create policy "Users can delete their own workloads"
  on public.workloads for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do update
    set display_name = excluded.display_name;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
