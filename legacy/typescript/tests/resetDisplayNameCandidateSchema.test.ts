import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("candidate migration declares the identity and lifecycle contract", () => {
  const sql = readFileSync(
    "supabase/migrations/20260908123000_create_reset_display_name_candidates.sql",
    "utf8",
  );

  assert.match(
    sql,
    /candidate_id\s+uuid\s+primary key\s+default\s+extensions\.gen_random_uuid\(\)/i,
  );
  assert.match(sql, /source_snapshot_hash\s+text/i);
  assert.match(sql, /input_hash\s+text/i);
  assert.match(sql, /'unprocessed'/i);
  assert.match(sql, /'pending'/i);
  assert.match(sql, /'notice-precompute-v1'/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /create or replace function public\.upsert_reset_display_name_candidate_seed/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /set search_path = pg_catalog, public, extensions/i);
  assert.match(
    sql,
    /revoke all on function public\.upsert_reset_display_name_candidate_seed\(jsonb\)\s+from\s+public,\s*anon,\s*authenticated/i,
  );
  assert.match(
    sql,
    /grant execute on function public\.upsert_reset_display_name_candidate_seed\(jsonb\)\s+to\s+service_role/i,
  );
  assert.doesNotMatch(
    sql,
    /grant execute on function public\.upsert_reset_display_name_candidate_seed\(jsonb\)[\s\S]*?to\s+(?:public|anon|authenticated)/i,
  );
});

test("candidate seed serialization uses stable official notice identity", () => {
  const sql = readFileSync(
    "supabase/migrations/20260908123000_create_reset_display_name_candidates.sql",
    "utf8",
  );
  const lockStatement = sql.match(
    /perform pg_catalog\.pg_advisory_xact_lock\([\s\S]*?\);/i,
  )?.[0];

  assert.ok(lockStatement, "candidate seed must acquire a transaction lock");
  assert.match(
    lockStatement,
    /pg_advisory_xact_lock\(\s*pg_catalog\.hashtext\(\s*'reset-display-name-candidate-seed'\s*\)\s*\)/i,
  );
  assert.doesNotMatch(lockStatement, /v_official_notice_tweet_id/i);
  assert.match(
    sql,
    /where\s+v_official_notice_tweet_id\s*=\s*any\s*\(notice_tweet_ids\)/i,
  );
  assert.match(sql, /notice_tweet_ids\s*&&\s*v_notice_tweet_ids/i);
  assert.match(sql, /official_notice_tweet_id\s*=\s*v_candidate\.official_notice_tweet_id/i);
  assert.match(
    sql,
    /coalesce\(v_candidate\.logical_post_id,\s*v_logical_post_id\)/i,
  );
});

test("candidate promotion RPC is service-role-only and transaction-scoped", () => {
  const sql = readFileSync(
    "supabase/migrations/20260908124500_create_promote_reset_display_name_candidate.sql",
    "utf8",
  );
  assert.match(sql, /create or replace function public\.promote_reset_display_name_candidate/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /set search_path = pg_catalog, public, extensions/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(
    sql,
    /revoke all on function public\.promote_reset_display_name_candidate\([^)]*\)\s+from\s+public,\s*anon,\s*authenticated/i,
  );
  assert.match(
    sql,
    /grant execute on function public\.promote_reset_display_name_candidate\([^)]*\)\s+to\s+service_role/i,
  );
  assert.doesNotMatch(
    sql,
    /grant execute on function public\.promote_reset_display_name_candidate\([^)]*\)[\s\S]*?to\s+(?:public|anon|authenticated)/i,
  );
  assert.match(sql, /tibo_formal_adoptions/i);
  assert.match(sql, /reset_execution_estimates/i);
  assert.match(sql, /execution_time_source\s*=\s*'usage_observation'/i);
  assert.doesNotMatch(sql, /insert\s+into\s+public\.reset_execution_estimates/i);
  assert.doesNotMatch(sql, /insert\s+into\s+public\.tibo_formal_adoptions/i);
});

test("candidate promotion RPC mirrors public-valid execution estimate semantics", () => {
  const sql = readFileSync(
    "supabase/migrations/20260908124500_create_promote_reset_display_name_candidate.sql",
    "utf8",
  );
  assert.match(sql, /execution_time_source\s*=\s*'usage_observation'/i);
  assert.match(sql, /execution_time_confidence\s*=\s*'high'/i);
  assert.match(sql, /execution_time_precision\s*=\s*'approximate'/i);
  assert.match(sql, /recovery_observation_id\s+is\s+not\s+null/i);
  assert.match(sql, /estimator_version\s+in\s*\([^)]*usage-execution-v1/i);
  assert.match(sql, /execution_window_start_at\s+is\s+not\s+null/i);
  assert.match(sql, /execution_window_end_at\s+is\s+not\s+null/i);
  assert.match(sql, /(?:e\.)?execution_window_start_at\s*<\s*(?:e\.)?execution_window_end_at/i);
  assert.match(sql, /(?:e\.)?display_execution_at\s*=\s*(?:e\.)?execution_window_end_at/i);
  assert.match(sql, /official_notice_tweet_id\s*=\s*any\s*\(v_candidate\.notice_tweet_ids\)/i);
  assert.match(sql, /official_notice_tweet_id\s*=\s*any\s*\((?:e\.)?tibo_source_tweet_ids\)/i);
});

test("candidate promotion replaces nonaccepted canonical AI fields consistently", () => {
  const sql = readFileSync(
    "supabase/migrations/20260908124500_create_promote_reset_display_name_candidate.sql",
    "utf8",
  );
  assert.match(sql, /ai_name_ja\s*=\s*v_candidate\.ai_name_ja/i);
  assert.match(sql, /ai_name_en\s*=\s*v_candidate\.ai_name_en/i);
  assert.match(sql, /ai_name_zh\s*=\s*v_candidate\.ai_name_zh/i);
  assert.match(sql, /ai_confidence\s*=\s*v_candidate\.ai_confidence/i);
  assert.match(sql, /ai_flags\s*=\s*v_candidate\.ai_flags/i);
  assert.doesNotMatch(sql, /ai_name_ja\s*=\s*coalesce\s*\(v_existing_name\.ai_name_ja/i);
  assert.doesNotMatch(sql, /ai_name_en\s*=\s*coalesce\s*\(v_existing_name\.ai_name_en/i);
  assert.doesNotMatch(sql, /ai_name_zh\s*=\s*coalesce\s*\(v_existing_name\.ai_name_zh/i);
});
