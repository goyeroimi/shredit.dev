import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({ hash: vi.fn() }));
vi.mock("@/lib/crypto/password", () => ({ hashPassword: mocks.hash }));
import { migrateDatabase } from "@/lib/database/migrate";
import { REQUEST_FINGERPRINT_HASH_PATTERN } from "@/lib/database/schema";
import { resetEnvForTests } from "@/lib/config/env";
import { requestFingerprint } from "@/lib/crypto/protocol";

const initialSql = readFileSync(
  fileURLToPath(new URL("../drizzle/0000_initial.sql", import.meta.url)),
  "utf8",
);
const encodedHash =
  "$argon2id$v=19$m=8192,t=1,p=1$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU";

type LegacyRow = {
  key_digest: Buffer;
  request_fingerprint: string;
  note_id_digest: Buffer;
  note_deleted_at: Date | null;
  response_expires_at: Date | null;
};

/** Transactional fake: the native-PostgreSQL integration gate is separate. */
function database(version: number | null = 1, count = 3) {
  let state = {
    version,
    type: "bytea",
    retained: -1,
    rows: Array.from({ length: count }, (_, index): LegacyRow => {
      const key = Buffer.alloc(32);
      key.writeUInt32BE(index + 1, 28);
      return {
        key_digest: key,
        request_fingerprint: Buffer.alloc(32, index % 256).toString("hex"),
        note_id_digest: Buffer.alloc(32, (index + 1) % 256),
        note_deleted_at: index % 2 ? new Date("2026-01-01") : null,
        response_expires_at: index % 3 ? new Date("2026-02-01") : null,
      };
    }),
  };
  let before: typeof state;
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql === "BEGIN") {
      before = { ...state, rows: state.rows.map((row) => ({ ...row })) };
      return { rows: [], rowCount: 0 };
    }
    if (sql === "ROLLBACK") {
      state = before;
      return { rows: [], rowCount: 0 };
    }
    if (
      sql === "COMMIT" ||
      sql.includes("pg_advisory_xact_lock") ||
      sql.includes("LOCK TABLE")
    )
      return { rows: [], rowCount: 0 };
    if (sql.includes("AS version_table"))
      return {
        rows: [
          {
            version_table:
              state.version === null ? null : "shredit_schema_version",
            has_legacy_tables: state.version !== null,
          },
        ],
        rowCount: 1,
      };
    if (sql === initialSql) {
      state.version = 1;
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT version"))
      return { rows: [{ version: state.version }], rowCount: 1 };
    if (sql.includes("AS valid"))
      return { rows: [{ valid: state.type === "bytea" }], rowCount: 1 };
    if (sql.includes("ALTER COLUMN request_fingerprint TYPE text")) {
      state.type = "text";
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT key_digest, request_fingerprint")) {
      const cursor = values?.[0] as Buffer | null;
      const rows = state.rows
        .filter((row) => !cursor || Buffer.compare(row.key_digest, cursor) > 0)
        .slice(0, values?.[1] as number);
      // Real query rows are snapshots, not aliases to records updated later.
      return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
    }
    if (
      sql.startsWith("UPDATE note_create_idempotency SET request_fingerprint")
    ) {
      state.rows.find((row) =>
        row.key_digest.equals(values?.[1] as Buffer),
      )!.request_fingerprint = values?.[0] as string;
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.includes(
        "ADD CONSTRAINT note_create_idempotency_fingerprint_argon2_check",
      )
    ) {
      if (
        state.rows.some(
          (row) =>
            !new RegExp(REQUEST_FINGERPRINT_HASH_PATTERN).test(
              row.request_fingerprint,
            ),
        )
      )
        throw new Error("format check");
      state.retained = state.rows.length;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id FROM note_capacity"))
      return { rows: [{ id: 1 }], rowCount: 1 };
    if (sql.startsWith("UPDATE shredit_schema_version SET version = 2")) {
      state.version = 2;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected migration query: ${sql}`);
  });
  const pool = {
    connect: vi.fn(async () => ({ query, release }) as unknown as PoolClient),
  } as unknown as Pick<Pool, "connect">;
  return { pool, query, release, state: () => state };
}

beforeEach(() => {
  mocks.hash.mockReset().mockResolvedValue(encodedHash);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe("schema version 2 migration", () => {
  it("transforms active and deleted legacy rows in bounded keyset batches without altering replay fields", async () => {
    const db = database(1, 205);
    const originals = db.state().rows.map((row) => ({ ...row }));
    expect(await migrateDatabase(db.pool, initialSql)).toBe(2);
    expect(db.state().version).toBe(2);
    expect(db.state().type).toBe("text");
    expect(db.state().retained).toBe(205);
    expect(mocks.hash).toHaveBeenCalledTimes(205);
    for (let index = 0; index < originals.length; index++) {
      expect(mocks.hash).toHaveBeenNthCalledWith(
        index + 1,
        originals[index].request_fingerprint,
      );
      expect(db.state().rows[index]).toEqual({
        ...originals[index],
        request_fingerprint: encodedHash,
      });
    }
    const reads = db.query.mock.calls.filter(([sql]) =>
      sql.includes("SELECT key_digest, request_fingerprint"),
    );
    expect(reads).toHaveLength(4);
    for (const [sql, values] of reads) {
      expect(sql).toContain("ORDER BY key_digest LIMIT $2");
      expect(values?.[1]).toBe(100);
    }
    const statements = db.query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("pg_advisory_xact_lock");
    expect(statements[statements.length - 1]).toBe("COMMIT");
    expect(statements).not.toContain(initialSql);
    expect(
      statements.some((sql) =>
        /UPDATE notes|DELETE FROM notes|TRUNCATE/u.test(sql),
      ),
    ).toBe(false);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("applies immutable 0000 only for an empty unversioned database and is idempotent on v2", async () => {
    const db = database(null, 0);
    await migrateDatabase(db.pool, initialSql);
    expect(
      db.query.mock.calls.filter(([sql]) => sql === initialSql),
    ).toHaveLength(1);
    db.query.mockClear();
    mocks.hash.mockClear();
    await migrateDatabase(db.pool, initialSql);
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(
      db.query.mock.calls.some(
        ([sql]) =>
          sql === initialSql ||
          sql.includes("ALTER TABLE") ||
          sql.includes("SET version"),
      ),
    ).toBe(false);
    expect(db.state().version).toBe(2);
  });

  it("preserves the legacy password-bearing fingerprint through native salted Argon2", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ARGON2_MEMORY_KIB", "8192");
    vi.stubEnv("ARGON2_TIME_COST", "1");
    resetEnvForTests();
    const actual = await vi.importActual<
      typeof import("@/lib/crypto/password")
    >("@/lib/crypto/password");
    mocks.hash.mockImplementation(actual.hashPassword);
    const tuple = {
      id: "A".repeat(32),
      protocolVersion: 1,
      iv: new Uint8Array(12),
      ciphertext: new Uint8Array(16),
      surface: "clearnet" as const,
      expiresIn: "7d" as const,
      normalizedPassword: "original password",
      secret: "test-hmac-secret",
    };
    const legacy = Buffer.from(requestFingerprint(tuple)).toString("hex");
    const db = database(1, 2);
    for (const row of db.state().rows) row.request_fingerprint = legacy;
    await migrateDatabase(db.pool, initialSql);
    const hashes = db.state().rows.map((row) => row.request_fingerprint);
    expect(hashes[0]).not.toBe(hashes[1]);
    for (const hash of hashes) {
      expect(await actual.verifyPassword(legacy, hash)).toBe(true);
      const changed = Buffer.from(
        requestFingerprint({
          ...tuple,
          normalizedPassword: "changed password",
        }),
      ).toString("hex");
      expect(await actual.verifyPassword(changed, hash)).toBe(false);
      expect(hash).not.toContain(legacy);
    }
    expect(db.state().rows[0].note_deleted_at).toBeNull();
    expect(db.state().rows[1].note_deleted_at).toEqual(new Date("2026-01-01"));
  });

  it("serializes two migrators before version inspection so only one upgrades", async () => {
    const db = database();
    const normal = db.query.getMockImplementation()!;
    let lock = Promise.resolve();
    let releaseLock: (() => void) | undefined;
    db.query.mockImplementation(async (sql, values) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        const previous = lock;
        let release!: () => void;
        lock = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        releaseLock = release;
      }
      const result = await normal(sql, values);
      if (sql === "COMMIT") releaseLock?.();
      return result;
    });
    expect(
      await Promise.all([
        migrateDatabase(db.pool, initialSql),
        migrateDatabase(db.pool, initialSql),
      ]),
    ).toEqual([2, 2]);
    expect(mocks.hash).toHaveBeenCalledTimes(3);
    expect(
      db.query.mock.calls.filter(([sql]) =>
        sql.startsWith("UPDATE shredit_schema_version"),
      ),
    ).toHaveLength(1);
    expect(db.release).toHaveBeenCalledTimes(2);
  });

  it("rolls the whole migration back on an Argon failure and can safely retry", async () => {
    const db = database(1, 3);
    const originals = db.state().rows.map((row) => ({ ...row }));
    mocks.hash
      .mockResolvedValueOnce(encodedHash)
      .mockRejectedValueOnce(new Error("Argon timeout"));
    await expect(migrateDatabase(db.pool, initialSql)).rejects.toThrow(
      "Argon timeout",
    );
    expect(db.state()).toMatchObject({
      version: 1,
      type: "bytea",
      retained: -1,
      rows: originals,
    });
    expect(db.query).toHaveBeenCalledWith("ROLLBACK");
    expect(db.query).not.toHaveBeenCalledWith("COMMIT");
    expect(db.release).toHaveBeenCalledOnce();
    mocks.hash.mockReset().mockResolvedValue(encodedHash);
    await migrateDatabase(db.pool, initialSql);
    expect(db.state().version).toBe(2);
    expect(mocks.hash).toHaveBeenCalledTimes(3);
  });

  it("rolls back completed hashing if a final schema change fails", async () => {
    const db = database();
    const original = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql, values) => {
      if (sql.includes("ADD COLUMN retained_note_count"))
        throw new Error("DDL failure");
      return original(sql, values);
    });
    await expect(migrateDatabase(db.pool, initialSql)).rejects.toThrow(
      "DDL failure",
    );
    expect(db.state().version).toBe(1);
    expect(
      db
        .state()
        .rows.every((row) => /^[a-f0-9]{64}$/u.test(row.request_fingerprint)),
    ).toBe(true);
    expect(db.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it.each([0, 3, 99])(
    "rejects unsupported version %s without rerunning 0000 or downgrading",
    async (version) => {
      const db = database(version);
      await expect(migrateDatabase(db.pool, initialSql)).rejects.toThrow(
        "Unsupported",
      );
      expect(db.state().version).toBe(version);
      expect(
        db.query.mock.calls.some(
          ([sql]) =>
            sql === initialSql ||
            sql.includes("ALTER TABLE") ||
            sql.includes("SET version"),
        ),
      ).toBe(false);
    },
  );

  it("rejects an unversioned partial schema instead of assuming a fresh database", async () => {
    const db = database();
    const original = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql, values) =>
      sql.includes("AS version_table")
        ? {
            rows: [{ version_table: null, has_legacy_tables: true }],
            rowCount: 1,
          }
        : original(sql, values),
    );
    await expect(migrateDatabase(db.pool, initialSql)).rejects.toThrow(
      "Unversioned",
    );
    expect(db.query.mock.calls.some(([sql]) => sql === initialSql)).toBe(false);
  });

  it("rejects a malformed legacy fingerprint, rather than preserving or silently skipping it", async () => {
    const db = database();
    db.state().rows[1].request_fingerprint = "bad";
    await expect(migrateDatabase(db.pool, initialSql)).rejects.toThrow(
      "Invalid legacy",
    );
    expect(db.state().version).toBe(1);
    expect(db.query).toHaveBeenCalledWith("ROLLBACK");
  });
});
