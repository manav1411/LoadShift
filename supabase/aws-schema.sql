-- Run this in the Supabase SQL Editor.
-- The ec2_power_profiles rows should be populated from the Teads Engineering
-- EC2 power dataset before carbon estimates are considered production-ready.

create extension if not exists pgcrypto;

create table if not exists public.aws_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role_arn text,
  external_id text not null,
  aws_account_id text,
  status text not null default 'pending',
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  constraint aws_connections_status_check check (status in ('pending', 'connected'))
);

alter table public.aws_connections enable row level security;
revoke all on table public.aws_connections from anon;
grant select, insert, update, delete on table public.aws_connections to authenticated;

drop policy if exists "Users can manage their AWS connection" on public.aws_connections;
create policy "Users can manage their AWS connection"
  on public.aws_connections for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create table if not exists public.ec2_power_profiles (
  instance_type text primary key,
  idle_watts numeric not null check (idle_watts >= 0),
  max_watts numeric not null check (max_watts >= idle_watts),
  source text not null default 'Teads Engineering',
  source_url text,
  updated_at timestamptz not null default now()
);

alter table public.ec2_power_profiles enable row level security;
revoke all on table public.ec2_power_profiles from anon;
grant select on table public.ec2_power_profiles to authenticated;

drop policy if exists "Signed-in users can read EC2 power profiles" on public.ec2_power_profiles;
create policy "Signed-in users can read EC2 power profiles"
  on public.ec2_power_profiles for select
  to authenticated
  using (true);

-- Example import shape. Replace these values with the complete Teads table:
-- insert into public.ec2_power_profiles
--   (instance_type, idle_watts, max_watts, source_url)
-- values
--   ('m5.large', 18, 58, 'https://engineering.teads.com/2021/09/23/building-an-aws-ec2-carbon-emissions-dataset-2/');
