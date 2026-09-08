-- Applied to Supabase with migration add_brady_passage_recordings.
-- Audio is kept in the database rather than the public phrase bucket so
-- historical recordings cannot be listed or played with the public API key.
create table public.brady_torah_passage_recordings_v1 (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 120),
  start_time timestamptz not null,
  passage_key text not null default 'genesis-42-8-23' check (passage_key = 'genesis-42-8-23'),
  mime_type text not null check (mime_type in ('audio/webm', 'audio/ogg', 'audio/mp4')),
  audio_base64 text not null check (char_length(audio_base64) between 1 and 12000000)
);
alter table public.brady_torah_passage_recordings_v1 enable row level security;
grant select, insert, update, delete on public.brady_torah_passage_recordings_v1 to anon;
create policy current_recording_only on public.brady_torah_passage_recordings_v1
for all to anon
using (id::text = (current_setting('request.headers', true)::jsonb ->> 'x-recording-id'))
with check (id::text = (current_setting('request.headers', true)::jsonb ->> 'x-recording-id'));
