-- Extra pieces the end-to-end backend needs on top of supabase_stub.sql:
-- the role PostgREST logs in as, and a password store for the mock auth.

create role authenticator login noinherit;
grant anon, authenticated to authenticator;

create table auth.passwords (
  user_id uuid primary key references auth.users (id) on delete cascade,
  hash text not null
);
