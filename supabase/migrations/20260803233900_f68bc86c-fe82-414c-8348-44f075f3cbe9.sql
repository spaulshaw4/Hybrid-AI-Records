create or replace function private.draft_request_secret(_header text)
returns text
language sql
stable
set search_path = public
as $$
  select nullif(
    coalesce(
      current_setting('request.headers', true)::json ->> _header,
      ''
    ),
    ''
  )
$$;

create or replace function private.draft_secret_hash(_header text)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when private.draft_request_secret(_header) is null then null
    else encode(sha256(convert_to(private.draft_request_secret(_header), 'UTF8')), 'hex')
  end
$$;

create or replace function private.owns_form_draft(_resume_token_hash text, _owner_key_hash text, _token_expires_at timestamptz)
returns boolean
language sql
stable
set search_path = public
as $$
  select
    (
      _resume_token_hash is not null
      and private.draft_secret_hash('x-draft-resume-token') is not null
      and _resume_token_hash = private.draft_secret_hash('x-draft-resume-token')
      and (_token_expires_at is null or _token_expires_at > now())
    )
    or (
      _owner_key_hash is not null
      and private.draft_secret_hash('x-draft-owner-key') is not null
      and _owner_key_hash = private.draft_secret_hash('x-draft-owner-key')
    )
$$;

revoke all on function private.draft_request_secret(text) from public;
revoke all on function private.draft_secret_hash(text) from public;
revoke all on function private.owns_form_draft(text, text, timestamptz) from public;
grant execute on function private.owns_form_draft(text, text, timestamptz) to anon, authenticated;

grant select, update on public.form_drafts to anon, authenticated;

drop policy if exists "Draft owners can read their own draft" on public.form_drafts;
create policy "Draft owners can read their own draft"
on public.form_drafts
for select
to anon, authenticated
using (private.owns_form_draft(resume_token_hash, owner_key_hash, token_expires_at));

drop policy if exists "Draft owners can update their own draft" on public.form_drafts;
create policy "Draft owners can update their own draft"
on public.form_drafts
for update
to anon, authenticated
using (private.owns_form_draft(resume_token_hash, owner_key_hash, token_expires_at))
with check (private.owns_form_draft(resume_token_hash, owner_key_hash, token_expires_at));