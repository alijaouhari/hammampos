-- Whether the PC's live command channel is open (reported with the heartbeat).
alter table public.locations add column if not exists live boolean;
