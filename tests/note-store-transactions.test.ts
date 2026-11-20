import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  getDatabase: vi.fn(),
  query: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  lookup: vi.fn(),
  hash: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("@/lib/database/client", () => ({
  getPool: mocks.getPool,
  getDatabase: mocks.getDatabase,
}));
vi.mock("@/lib/crypto/password", () => ({
  hashPassword: mocks.hash,
  verifyPassword: mocks.verify,
}));

import { resetEnvForTests } from "@/lib/config/env";
import { noteStore, type NoteCreateRecord } from "@/lib/note-store";

const input: NoteCreateRecord = {
  id: "A".repeat(32),
  protocolVersion: 1,
  iv: new Uint8Array(12),
  ciphertext: new Uint8Array(16),
  expiresAt: null,
  keyDigest: new Uint8Array(32).fill(1),
  fingerprint: new Uint8Array(32).fill(2),
  noteIdDigest: new Uint8Array(32).fill(3),
  surface: "clearnet",
};
let inTransaction = false;
let retained = "0";
let racingRow:
  | {
      request_fingerprint: string;
      response_expires_at: Date | null;
      surface: string;
    }
  | undefined;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SHREDIT_LOCAL_EPHEMERAL", "false");
  vi.stubEnv("MAX_ACTIVE_NOTE_BYTES", "1000");
  vi.stubEnv("MAX_ACTIVE_NOTE_COUNT", "10");
  vi.stubEnv("MAX_RETAINED_NOTE_COUNT", "2");
  resetEnvForTests();
  for (const mock of Object.values(mocks)) mock.mockReset();
  inTransaction = false;
  retained = "0";
  racingRow = undefined;
  mocks.lookup.mockResolvedValue([]);
  mocks.getDatabase.mockReturnValue({
    select: () => ({
      from: () => ({ where: () => ({ limit: mocks.lookup }) }),
    }),
  });
  mocks.connect.mockResolvedValue({
    query: mocks.query,
    release: mocks.release,
  });
  mocks.getPool.mockReturnValue({ connect: mocks.connect });
  mocks.hash.mockImplementation(async () => {
    expect(inTransaction).toBe(false);
    return "new-salted-argon-hash";
  });
  mocks.verify.mockImplementation(async () => {
    expect(inTransaction).toBe(false);
    return true;
  });
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql === "BEGIN") {
      inTransaction = true;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT" || sql === "ROLLBACK") {
      inTransaction = false;
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT active_note_count"))
      return {
        rows: [
          {
            active_note_count: "0",
            active_payload_bytes: "0",
            retained_note_count: retained,
          },
        ],
        rowCount: 1,
      };
    if (sql.includes("SELECT request_fingerprint"))
      return {
        rows: racingRow ? [racingRow] : [],
        rowCount: racingRow ? 1 : 0,
      };
    if (sql.includes("SELECT 1 FROM notes")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT id FROM note_capacity"))
      return { rows: [{ id: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
});

afterEach(async () => {
  if (process.env.SHREDIT_LOCAL_EPHEMERAL === "true")
    await noteStore.resetForTests();
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe("fingerprint hashing and lock order", () => {
  it("does no Argon work for an absent replay key", async () => {
    expect(await noteStore.checkReplay(input)).toEqual({ kind: "missing" });
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("hashes before BEGIN and inserts text with an atomic retained reservation", async () => {
    expect((await noteStore.create(input)).kind).toBe("created");
    expect(mocks.hash).toHaveBeenCalledWith(
      Buffer.from(input.fingerprint).toString("hex"),
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO note_create_idempotency"),
      [
        Buffer.from(input.keyDigest),
        "new-salted-argon-hash",
        Buffer.from(input.noteIdDigest),
        null,
        "clearnet",
      ],
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("retained_note_count = retained_note_count + 1"),
      [16],
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("does not acquire capacity or mutate storage when hashing fails", async () => {
    mocks.hash.mockRejectedValue(new Error("Argon queue full"));
    await expect(noteStore.create(input)).rejects.toThrow("Argon queue full");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "verifies a racing row after COMMIT/release, not by comparing salts (%s)",
    async (matches) => {
      racingRow = {
        request_fingerprint: "different-salted-existing-hash",
        response_expires_at: new Date("2026-12-01"),
        surface: "clearnet",
      };
      retained = "2";
      mocks.verify.mockImplementation(async () => {
        expect(inTransaction).toBe(false);
        expect(mocks.release).toHaveBeenCalledOnce();
        return matches;
      });
      const result = await noteStore.create(input);
      expect(result).toEqual(
        matches
          ? {
              kind: "replay",
              id: input.id,
              expiresAt: racingRow.response_expires_at,
            }
          : { kind: "idempotency-conflict" },
      );
      expect(mocks.verify).toHaveBeenCalledWith(
        Buffer.from(input.fingerprint).toString("hex"),
        racingRow.request_fingerprint,
      );
      expect(
        mocks.query.mock.calls.some(([sql]) =>
          String(sql).includes("INSERT INTO"),
        ),
      ).toBe(false);
    },
  );

  it("uses a retained immutable snapshot for existing replay without any capacity lock", async () => {
    mocks.lookup.mockResolvedValue([
      {
        requestFingerprint: "existing-hash",
        responseExpiresAt: null,
        surface: "clearnet",
      },
    ]);
    expect((await noteStore.create(input)).kind).toBe("replay");
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects new keys at the retained limit, without inserting or incrementing", async () => {
    retained = "2";
    expect((await noteStore.create(input)).kind).toBe("storage-full");
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        /INSERT INTO|UPDATE note_capacity/u.test(String(sql)),
      ),
    ).toBe(false);
  });

  it("rolls back note, idempotency and capacity when a create write fails", async () => {
    const normal = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE note_capacity"))
        throw new Error("ledger failure");
      return normal(sql);
    });
    await expect(noteStore.create(input)).rejects.toThrow("ledger failure");
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("keeps memory hashing and both replay paths outside the Map lock", async () => {
    vi.stubEnv("SHREDIT_LOCAL_EPHEMERAL", "true");
    resetEnvForTests();
    await noteStore.resetForTests();
    mocks.hash.mockImplementation(async () => {
      await noteStore.stats();
      return "salted-hash";
    });
    mocks.verify.mockImplementation(async () => {
      await noteStore.stats();
      return true;
    });
    const results = await Promise.all([
      noteStore.create(input),
      noteStore.create(input),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      "created",
      "replay",
    ]);
    expect((await noteStore.checkReplay(input)).kind).toBe("replay");
  });
});

describe("wall-clock consume and tombstone cleanup", () => {
  it.each([undefined, "valid password"])(
    "checks expiry after capacity lock for password %s",
    async (password) => {
      mocks.lookup.mockResolvedValue([
        { passwordHash: password ? "password-hash" : null },
      ]);
      let locked = false;
      const normal = mocks.query.getMockImplementation()!;
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT id FROM note_capacity")) locked = true;
        if (sql.includes("DELETE FROM notes")) {
          expect(locked).toBe(true);
          expect(sql).toContain("expires_at > clock_timestamp()");
          expect(sql).not.toContain("now()");
          return { rows: [], rowCount: 0 };
        }
        return normal(sql);
      });
      expect(await noteStore.consume(input.id, password)).toEqual({
        kind: "unavailable",
      });
      expect(
        mocks.query.mock.calls.some(([sql]) =>
          String(sql).includes("UPDATE note_create_idempotency"),
        ),
      ).toBe(false);
    },
  );

  it.each([undefined, "valid password"])(
    "timestamps successful consume with wall time (%s)",
    async (password) => {
      mocks.lookup.mockResolvedValue([
        { passwordHash: password ? "password-hash" : null },
      ]);
      const normal = mocks.query.getMockImplementation()!;
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes("DELETE FROM notes"))
          return {
            rows: [
              {
                id: input.id,
                iv: Buffer.alloc(12),
                ciphertext: Buffer.alloc(16),
                payload_bytes: 16,
              },
            ],
            rowCount: 1,
          };
        return normal(sql);
      });
      expect((await noteStore.consume(input.id, password)).kind).toBe(
        "success",
      );
      expect(mocks.query).toHaveBeenCalledWith(
        expect.stringContaining("note_deleted_at = clock_timestamp()"),
        [expect.any(Buffer)],
      );
      expect(
        mocks.query.mock.calls.some(([sql]) =>
          String(sql).includes("retained_note_count = retained_note_count -"),
        ),
      ).toBe(false);
    },
  );

  it.each([
    [undefined, 100],
    [0, 1],
    [1001, 1000],
    [1.9, 1],
    [Number.NaN, 100],
  ])(
    "bounds cleanup limit %s to %s with capacity-first locking",
    async (requested, bounded) => {
      expect(await noteStore.cleanupTombstones(30, requested)).toBe(1);
      const calls = mocks.query.mock.calls;
      const capacity = calls.findIndex(([sql]) =>
        String(sql).includes("FOR UPDATE"),
      );
      const deletion = calls.findIndex(([sql]) =>
        String(sql).includes("DELETE FROM note_create_idempotency"),
      );
      expect(capacity).toBeLessThan(deletion);
      const sql = calls[deletion][0] as string;
      expect(sql).toContain("note_deleted_at IS NOT NULL");
      expect(sql).toContain("clock_timestamp()");
      expect(sql).toContain("interval '24 hours'");
      expect(sql).toContain("ORDER BY note_deleted_at, key_digest");
      expect(sql).toContain("FOR UPDATE SKIP LOCKED");
      expect(calls[deletion][1]).toEqual([30, bounded]);
      expect(mocks.query).toHaveBeenCalledWith(
        expect.stringContaining(
          "retained_note_count = retained_note_count - $1",
        ),
        [1],
      );
      expect(mocks.query).toHaveBeenCalledWith("COMMIT");
    },
  );

  it("rolls back tombstone deletion if its ledger decrement fails", async () => {
    const normal = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("retained_note_count = retained_note_count -"))
        throw new Error("ledger failure");
      return normal(sql);
    });
    await expect(noteStore.cleanupTombstones(30)).rejects.toThrow(
      "ledger failure",
    );
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT");
  });
});
