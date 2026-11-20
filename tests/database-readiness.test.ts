import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const databaseMocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: databaseMocks.drizzle,
}));

import { databaseReady } from "@/lib/database/client";
import { resetEnvForTests } from "@/lib/config/env";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://test:test@127.0.0.1:5432/shredit_test",
  );
  resetEnvForTests();
  databaseMocks.execute.mockReset();
  databaseMocks.drizzle.mockReturnValue({ execute: databaseMocks.execute });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe("database readiness", () => {
  it("returns false when the note_capacity singleton row is absent", async () => {
    databaseMocks.execute.mockResolvedValue({ rows: [{ ready: false }] });

    await expect(databaseReady()).resolves.toBe(false);
  });

  it("returns true only when the schema-version and invariant query returns true", async () => {
    databaseMocks.execute.mockResolvedValue({ rows: [{ ready: true }] });

    await expect(databaseReady()).resolves.toBe(true);
    const statement = new PgDialect().sqlToQuery(
      databaseMocks.execute.mock.calls[0][0],
    ).sql;
    expect(statement).toContain("version = 2");
    expect(statement).toContain("retained_note_count >= 0");
    expect(statement).toContain("atttypid = 'text'::regtype");
    expect(statement).toContain("atttypid = 'bigint'::regtype");
    expect(statement).toContain("note_capacity_retained_count_check");
    expect(statement).toContain(
      "note_create_idempotency_fingerprint_argon2_check",
    );
    expect(statement).toContain("not constraint_record.convalidated");
    expect(statement).not.toContain("fingerprint_len_check");
  });

  it("returns false when the readiness query fails", async () => {
    databaseMocks.execute.mockRejectedValue(new Error("database unavailable"));

    await expect(databaseReady()).resolves.toBe(false);
  });
});
