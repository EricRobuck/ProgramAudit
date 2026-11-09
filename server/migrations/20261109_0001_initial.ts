import type { Knex } from 'knex';

/**
 * Initial ProgramAudit schema. All objects live in the ProgramAudit database
 * only. Completed responses and report snapshots are never cascade-deleted.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table users (
      id bigserial primary key,
      email text not null check (length(email) between 3 and 254),
      display_name text not null check (length(btrim(display_name)) between 1 and 120),
      password_hash text not null,
      role text not null check (role in ('admin','coordinator','professor')),
      is_faculty boolean not null default true,
      active boolean not null default true,
      timezone text not null default 'America/New_York',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index users_email_uq on users (lower(email));

    create table curricula (
      id bigserial primary key,
      name text not null check (length(btrim(name)) between 1 and 200),
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index curricula_name_uq on curricula (lower(name));

    create table majors (
      id bigserial primary key,
      curriculum_id bigint not null references curricula(id) on delete restrict,
      name text not null check (length(btrim(name)) between 1 and 200),
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index majors_name_uq on majors (curriculum_id, lower(name));

    create table reviews (
      id bigserial primary key,
      major_id bigint not null references majors(id) on delete restrict,
      title text not null check (length(btrim(title)) between 1 and 200),
      period text not null default '',
      description text not null default '',
      archived_at timestamptz,
      archived_by bigint references users(id) on delete restrict,
      created_by bigint not null references users(id) on delete restrict,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index reviews_title_uq on reviews (major_id, lower(title));

    create table review_access (
      review_id bigint not null references reviews(id) on delete restrict,
      user_id bigint not null references users(id) on delete restrict,
      access text not null check (access in ('coordinator','faculty')),
      granted_by bigint references users(id) on delete restrict,
      created_at timestamptz not null default now(),
      primary key (review_id, user_id)
    );
    create index review_access_user_idx on review_access (user_id);

    create table tasks (
      id bigserial primary key,
      review_id bigint not null references reviews(id) on delete restrict,
      section text not null check (section in ('past','present','future')),
      parent_id bigint,
      title text not null check (length(btrim(title)) between 1 and 300),
      instructions text not null default '',
      assignee_id bigint references users(id) on delete restrict,
      due_date date,
      status text not null default 'not_started' check (status in ('not_started','in_progress','complete')),
      sort_order integer not null default 0,
      current_revision_no integer not null default 0,
      completed_at timestamptz,
      completed_by bigint references users(id) on delete restrict,
      completed_revision_no integer,
      reopened_at timestamptz,
      reopened_by bigint references users(id) on delete restrict,
      archived_at timestamptz,
      archived_by bigint references users(id) on delete restrict,
      archive_batch uuid,
      created_by bigint not null references users(id) on delete restrict,
      updated_by bigint not null references users(id) on delete restrict,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint tasks_identity_uq unique (id, review_id, section),
      -- A parent must be in the same review and section. Changing a task's
      -- section cascades to its entire subtree, keeping the tree consistent.
      constraint tasks_parent_fk foreign key (parent_id, review_id, section)
        references tasks (id, review_id, section) on update cascade on delete restrict,
      constraint tasks_not_self_parent check (parent_id is null or parent_id <> id),
      constraint tasks_completion_consistent check (
        (status = 'complete') = (completed_at is not null and completed_revision_no is not null)
      )
    );
    create index tasks_review_idx on tasks (review_id, section, parent_id, sort_order);
    create index tasks_assignee_idx on tasks (assignee_id) where assignee_id is not null;

    create table response_revisions (
      id bigserial primary key,
      task_id bigint not null references tasks(id) on delete restrict,
      revision_no integer not null check (revision_no > 0),
      content_html text not null,
      plain_text text not null,
      word_count integer not null,
      author_id bigint not null references users(id) on delete restrict,
      restored_from_revision_no integer,
      created_at timestamptz not null default now(),
      unique (task_id, revision_no)
    );

    create table report_snapshots (
      id bigserial primary key,
      review_id bigint not null references reviews(id) on delete restrict,
      mode text not null check (mode in ('working','completed')),
      options jsonb not null default '{}',
      content jsonb not null,
      source_revisions jsonb not null,
      active_task_count integer not null,
      completed_task_count integer not null,
      created_by bigint not null references users(id) on delete restrict,
      created_at timestamptz not null default now()
    );
    create index report_snapshots_review_idx on report_snapshots (review_id, created_at desc);

    create table activity_log (
      id bigserial primary key,
      actor_id bigint references users(id) on delete restrict,
      review_id bigint references reviews(id) on delete restrict,
      task_id bigint references tasks(id) on delete restrict,
      action text not null,
      details jsonb not null default '{}',
      created_at timestamptz not null default now()
    );
    create index activity_review_idx on activity_log (review_id, created_at desc);
    create index activity_task_idx on activity_log (task_id, created_at desc);

    -- Revisions and report snapshots are append-only.
    create function programaudit_forbid_mutation() returns trigger language plpgsql as $fn$
    begin
      raise exception '% rows are immutable', tg_table_name using errcode = 'P0001';
    end $fn$;
    create trigger response_revisions_immutable before update or delete on response_revisions
      for each row execute function programaudit_forbid_mutation();
    create trigger report_snapshots_immutable before update or delete on report_snapshots
      for each row execute function programaudit_forbid_mutation();

    create table session (
      sid varchar not null primary key,
      sess json not null,
      expire timestamp(6) not null
    );
    create index session_expire_idx on session (expire);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists session;
    drop table if exists activity_log;
    drop table if exists report_snapshots;
    drop table if exists response_revisions;
    drop table if exists tasks;
    drop table if exists review_access;
    drop table if exists reviews;
    drop table if exists majors;
    drop table if exists curricula;
    drop table if exists users;
    drop function if exists programaudit_forbid_mutation();
  `);
}
