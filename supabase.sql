-- Familieappen: beskjeder, felles kalender og medlemsliste for en familie.
-- Kjør hele filen i Supabase → SQL Editor → «Run». Trygt å kjøre på nytt.
-- Samme Supabase-prosjekt som matdagboken og huskelista; tabellene har prefiks fa_.

create table if not exists public.fa_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Familien',
  invite_code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.fa_members (
  group_id uuid not null references public.fa_groups(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  display_name text not null default '',
  phone text,
  color text,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.fa_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.fa_groups(id) on delete cascade,
  sender uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  to_all boolean not null default true,
  recipients uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists fa_messages_group on public.fa_messages (group_id, created_at desc);

create table if not exists public.fa_acks (
  message_id uuid not null references public.fa_messages(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create table if not exists public.fa_events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.fa_groups(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  date date not null,
  start_time time,
  end_time time,
  repeat text not null default 'none' check (repeat in ('none', 'weekly')),
  until date,
  location text,
  who uuid[] not null default '{}',
  drivers jsonb not null default '{}',  -- dato → hvem som kjører den dagen
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists fa_events_group on public.fa_events (group_id, date);

create or replace function public.fa_is_member(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from fa_members where group_id = g and user_id = auth.uid());
$$;

alter table public.fa_groups enable row level security;
alter table public.fa_members enable row level security;
alter table public.fa_messages enable row level security;
alter table public.fa_acks enable row level security;
alter table public.fa_events enable row level security;

drop policy if exists "fa_groups_select" on public.fa_groups;
create policy "fa_groups_select" on public.fa_groups for select to authenticated using (fa_is_member(id));
drop policy if exists "fa_groups_update" on public.fa_groups;
create policy "fa_groups_update" on public.fa_groups for update to authenticated using (fa_is_member(id)) with check (fa_is_member(id));

drop policy if exists "fa_members_select" on public.fa_members;
create policy "fa_members_select" on public.fa_members for select to authenticated using (fa_is_member(group_id));
drop policy if exists "fa_members_update_self" on public.fa_members;
create policy "fa_members_update_self" on public.fa_members for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "fa_members_leave" on public.fa_members;
create policy "fa_members_leave" on public.fa_members for delete to authenticated using (user_id = auth.uid());

-- Beskjeder: alle ser beskjeder til «alle»; ellers bare avsender og valgte mottakere.
drop policy if exists "fa_messages_select" on public.fa_messages;
create policy "fa_messages_select" on public.fa_messages for select to authenticated
  using (fa_is_member(group_id) and (to_all or sender = auth.uid() or auth.uid() = any(recipients)));
drop policy if exists "fa_messages_insert" on public.fa_messages;
create policy "fa_messages_insert" on public.fa_messages for insert to authenticated
  with check (fa_is_member(group_id) and sender = auth.uid());
drop policy if exists "fa_messages_delete" on public.fa_messages;
create policy "fa_messages_delete" on public.fa_messages for delete to authenticated using (sender = auth.uid());

drop policy if exists "fa_acks_select" on public.fa_acks;
create policy "fa_acks_select" on public.fa_acks for select to authenticated
  using (exists (select 1 from fa_messages m where m.id = message_id));
drop policy if exists "fa_acks_insert" on public.fa_acks;
create policy "fa_acks_insert" on public.fa_acks for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from fa_messages m where m.id = message_id));
drop policy if exists "fa_acks_delete" on public.fa_acks;
create policy "fa_acks_delete" on public.fa_acks for delete to authenticated using (user_id = auth.uid());

drop policy if exists "fa_events_all" on public.fa_events;
create policy "fa_events_all" on public.fa_events for all to authenticated
  using (fa_is_member(group_id)) with check (fa_is_member(group_id));

-- Lag ny familiegruppe med kode, og bli medlem.
create or replace function public.fa_create_group(p_name text, p_display text, p_phone text)
returns public.fa_groups
language plpgsql security definer set search_path = public as $$
declare g fa_groups; abc text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; c text;
begin
  if auth.uid() is null then raise exception 'Ikke logget inn'; end if;
  loop
    c := '';
    for i in 1..6 loop c := c || substr(abc, 1 + floor(random() * length(abc))::int, 1); end loop;
    exit when not exists (select 1 from fa_groups where invite_code = c);
  end loop;
  insert into fa_groups (name, invite_code) values (coalesce(nullif(trim(p_name), ''), 'Familien'), c) returning * into g;
  insert into fa_members (group_id, user_id, display_name, phone)
    values (g.id, auth.uid(), coalesce(trim(p_display), ''), nullif(trim(p_phone), ''));
  return g;
end $$;

-- Bli med i en familiegruppe med koden.
create or replace function public.fa_join_group(p_code text, p_display text, p_phone text)
returns public.fa_groups
language plpgsql security definer set search_path = public as $$
declare g fa_groups;
begin
  if auth.uid() is null then raise exception 'Ikke logget inn'; end if;
  select * into g from fa_groups where invite_code = upper(trim(p_code));
  if g.id is null then raise exception 'Ukjent kode'; end if;
  insert into fa_members (group_id, user_id, display_name, phone)
    values (g.id, auth.uid(), coalesce(trim(p_display), ''), nullif(trim(p_phone), ''))
    on conflict (group_id, user_id) do update set display_name = excluded.display_name, phone = excluded.phone;
  return g;
end $$;

grant usage on schema public to authenticated;
grant select, update (name) on public.fa_groups to authenticated;
grant select, update (display_name, phone, color), delete on public.fa_members to authenticated;
grant select, insert, delete on public.fa_messages to authenticated;
grant select, insert, delete on public.fa_acks to authenticated;
grant select, insert, update, delete on public.fa_events to authenticated;
grant execute on function public.fa_is_member(uuid) to authenticated;
grant execute on function public.fa_create_group(text, text, text) to authenticated;
grant execute on function public.fa_join_group(text, text, text) to authenticated;
revoke execute on function public.fa_create_group(text, text, text) from anon, public;
revoke execute on function public.fa_join_group(text, text, text) from anon, public;

-- Sanntid: nye beskjeder og avtaler dukker opp hos de andre med en gang
do $$ begin alter publication supabase_realtime add table public.fa_messages; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.fa_acks; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.fa_events; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.fa_members; exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
