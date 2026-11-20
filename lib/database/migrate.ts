import type { Pool, PoolClient } from "pg";
import { hashPassword } from "@/lib/crypto/password";
import { REQUEST_FINGERPRINT_HASH_PATTERN } from "./schema";

export const CURRENT_SCHEMA_VERSION = 2;
const MIGRATION_BATCH_SIZE = 100;

/** Version 2 keeps the protocol fingerprint unchanged, but never stores its fast form. */
async function migrateToVersion2(client: PoolClient): Promise<void> {
  // This is an offline release migration, not a rolling-schema change. Block all
  // writers until the conversion and version marker commit together.
  await client.query(
    "LOCK TABLE note_capacity, notes, note_create_idempotency IN ACCESS EXCLUSIVE MODE",
  );
  const legacy = await client.query<{ valid: boolean }>(`
    SELECT exists (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'public.note_create_idempotency'::regclass
        AND attname = 'request_fingerprint' AND atttypid = 'bytea'::regtype
        AND attnotnull AND NOT attisdropped
    ) AS valid
  `);
  if (!legacy.rows[0]?.valid)
    throw new Error("Unexpected version 1 fingerprint type");

  // The temporary hex values are visible only inside this transaction. Converting
  // in place avoids leaving a legacy column (or a duplicate fast commitment).
  await client.query(`
    ALTER TABLE note_create_idempotency
      DROP CONSTRAINT note_create_idempotency_fingerprint_len_check;
    ALTER TABLE note_create_idempotency
      ALTER COLUMN request_fingerprint TYPE text USING encode(request_fingerprint, 'hex')
  `);
  let cursor: Buffer | null = null;
  for (;;) {
    const batch: {
      rows: Array<{ key_digest: Buffer; request_fingerprint: string }>;
    } = await client.query<{
      key_digest: Buffer;
      request_fingerprint: string;
    }>(
      `SELECT key_digest, request_fingerprint FROM note_create_idempotency
       WHERE key_digest > coalesce($1::bytea, ''::bytea)
       ORDER BY key_digest LIMIT $2`,
      [cursor, MIGRATION_BATCH_SIZE],
    );
    if (batch.rows.length === 0) break;
    // Sequential hashing shares the runtime's bounded Argon2 worker pool. Memory
    // and returned rows are bounded even when millions of tombstones exist.
    for (const row of batch.rows) {
      if (!/^[a-f0-9]{64}$/u.test(row.request_fingerprint))
        throw new Error("Invalid legacy request fingerprint");
      const encoded = await hashPassword(row.request_fingerprint);
      await client.query(
        "UPDATE note_create_idempotency SET request_fingerprint = $1 WHERE key_digest = $2",
        [encoded, row.key_digest],
      );
    }
    cursor = batch.rows[batch.rows.length - 1].key_digest;
  }

  await client.query(`
    ALTER TABLE note_create_idempotency
      ADD CONSTRAINT note_create_idempotency_fingerprint_argon2_check
      CHECK (octet_length(request_fingerprint) <= 512
        AND request_fingerprint ~ '${REQUEST_FINGERPRINT_HASH_PATTERN}');
    ALTER TABLE note_capacity
      ADD COLUMN retained_note_count bigint NOT NULL DEFAULT 0,
      ADD CONSTRAINT note_capacity_retained_count_check CHECK (retained_note_count >= 0);
    UPDATE note_capacity
      SET retained_note_count = (SELECT count(*) FROM note_create_idempotency),
          updated_at = clock_timestamp()
      WHERE id = 1;
    DROP INDEX note_create_idempotency_deleted_idx;
    CREATE INDEX note_create_idempotency_deleted_idx
      ON note_create_idempotency (note_deleted_at, key_digest)
  `);
  const capacity = await client.query(
    "SELECT id FROM note_capacity WHERE id = 1",
  );
  if (capacity.rowCount !== 1)
    throw new Error("Capacity ledger is not initialized");
  await client.query(
    "UPDATE shredit_schema_version SET version = 2, applied_at = clock_timestamp() WHERE singleton = true",
  );
}

/** Serialize migrators and atomically upgrade recognized versions; never downgrade. */
export async function migrateDatabase(
  pool: Pick<Pool, "connect">,
  initialSql: string,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('shredit:schema-migrations'))",
    );
    const tables = await client.query<{
      version_table: string | null;
      has_legacy_tables: boolean;
    }>(`
      SELECT to_regclass('public.shredit_schema_version')::text AS version_table,
             (to_regclass('public.notes') IS NOT NULL
               OR to_regclass('public.note_capacity') IS NOT NULL
               OR to_regclass('public.note_create_idempotency') IS NOT NULL) AS has_legacy_tables
    `);
    let version: number;
    if (!tables.rows[0]?.version_table) {
      if (tables.rows[0]?.has_legacy_tables)
        throw new Error("Unversioned Shredit schema requires operator review");
      await client.query(initialSql);
      version = 1;
    } else {
      const current = await client.query<{ version: number }>(
        "SELECT version FROM shredit_schema_version WHERE singleton = true",
      );
      if (current.rowCount !== 1)
        throw new Error("Missing schema version singleton");
      version = current.rows[0].version;
    }
    if (version !== 1 && version !== CURRENT_SCHEMA_VERSION)
      throw new Error("Unsupported Shredit schema version");
    if (version === 1) await migrateToVersion2(client);
    await client.query("COMMIT");
    return CURRENT_SCHEMA_VERSION;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
