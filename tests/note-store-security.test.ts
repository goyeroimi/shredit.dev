import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEnv, resetEnvForTests } from "@/lib/config/env";
import { verifyPassword } from "@/lib/crypto/password";
import { noteIdDigest, requestFingerprint } from "@/lib/crypto/protocol";
import { noteStore, type NoteCreateRecord } from "@/lib/note-store";

const day = 86_400_000;

function fixture(
  seed: number,
  expiresAt: Date | null = null,
): NoteCreateRecord {
  const id = Buffer.alloc(24, seed).toString("base64url");
  const base = {
    id,
    protocolVersion: 1 as const,
    iv: new Uint8Array(12).fill(seed),
    ciphertext: new Uint8Array(16).fill(seed),
    surface: "clearnet" as const,
  };
  return {
    ...base,
    expiresAt,
    keyDigest: new Uint8Array(32).fill(seed),
    fingerprint: requestFingerprint({
      ...base,
      expiresIn: "7d",
      secret: getEnv().IDEMPOTENCY_HMAC_SECRET,
    }),
    noteIdDigest: noteIdDigest(id, getEnv().IDEMPOTENCY_HMAC_SECRET),
  };
}

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SHREDIT_LOCAL_EPHEMERAL", "true");
  vi.stubEnv("PUBLIC_BASE_URL", "http://127.0.0.1:3232");
  vi.stubEnv("MAX_ACTIVE_NOTE_COUNT", "100");
  vi.stubEnv("MAX_ACTIVE_NOTE_BYTES", "100000");
  vi.stubEnv("MAX_RETAINED_NOTE_COUNT", "3");
  vi.stubEnv("ARGON2_MEMORY_KIB", "8192");
  vi.stubEnv("ARGON2_TIME_COST", "1");
  resetEnvForTests();
  await noteStore.resetForTests();
});

afterEach(async () => {
  await noteStore.resetForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe("memory store security invariants", () => {
  it("stores only salted Argon2 fingerprints, including the duplicate note object", async () => {
    const writes: unknown[] = [];
    const original = Map.prototype.set;
    vi.spyOn(Map.prototype, "set").mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
      value,
    ) {
      if (
        value &&
        typeof value === "object" &&
        ("payloadBytes" in value || "noteDeletedAt" in value)
      )
        writes.push(value);
      return original.call(this, key, value);
    });
    const first = fixture(1);
    const second = { ...fixture(2), fingerprint: first.fingerprint };
    await noteStore.create(first);
    await noteStore.create(second);
    const rows = writes.filter(
      (row) => (row as { fingerprintHash?: string }).fingerprintHash,
    ) as Array<{ fingerprintHash: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].fingerprintHash).toMatch(/^\$argon2id\$v=19\$/u);
    expect(rows[0].fingerprintHash).not.toBe(rows[1].fingerprintHash);
    expect(
      await verifyPassword(
        Buffer.from(first.fingerprint).toString("hex"),
        rows[0].fingerprintHash,
      ),
    ).toBe(true);
    for (const row of writes) {
      expect(row).not.toHaveProperty("fingerprint");
      expect(Object.values(row as object)).not.toContain(first.fingerprint);
      expect(Object.values(row as object)).not.toContain(
        Buffer.from(first.fingerprint).toString("hex"),
      );
    }
  });

  it("bounds consumed-note cycles but allows exact replay at full capacity", async () => {
    for (let seed = 1; seed <= 3; seed++) {
      const input = fixture(seed);
      expect((await noteStore.create(input)).kind).toBe("created");
      expect((await noteStore.consume(input.id)).kind).toBe("success");
    }
    expect((await noteStore.create(fixture(4))).kind).toBe("storage-full");
    expect((await noteStore.create(fixture(1))).kind).toBe("replay");
    expect(
      (
        await noteStore.checkReplay({
          ...fixture(1),
          fingerprint: new Uint8Array(32),
        })
      ).kind,
    ).toBe("idempotency-conflict");
    expect(
      (await noteStore.checkReplay({ ...fixture(1), surface: "onion" })).kind,
    ).toBe("idempotency-conflict");
    await expect(noteStore.stats()).resolves.toEqual({
      activeNoteCount: 0,
      activePayloadBytes: 0,
    });
  });

  it("keeps full tombstone retention, batches cleanup, and never prunes active rows", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(start);
    const active = fixture(1);
    const first = fixture(2);
    const second = fixture(3);
    await noteStore.create(active);
    await noteStore.create(first);
    await noteStore.create(second);
    await noteStore.consume(first.id);
    vi.setSystemTime(start.getTime() + day);
    await noteStore.consume(second.id);
    vi.setSystemTime(start.getTime() + 30 * day - 1);
    expect(await noteStore.cleanupTombstones(30, 1000)).toBe(0);
    vi.setSystemTime(start.getTime() + 30 * day);
    expect(await noteStore.cleanupTombstones(30, 0)).toBe(1);
    expect((await noteStore.checkReplay(first)).kind).toBe("missing");
    expect((await noteStore.checkReplay(second)).kind).toBe("replay");
    expect((await noteStore.create(fixture(4))).kind).toBe("created");
    vi.setSystemTime(start.getTime() + 31 * day);
    expect(await noteStore.cleanupTombstones(30, 1001)).toBe(1);
    expect(await noteStore.metadata(active.id)).toEqual({
      requiresPassword: false,
    });
    expect(await noteStore.cleanupTombstones(30)).toBe(0);
  });

  it("serializes concurrent tombstone batches and releases each retained slot once", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(start);
    for (let seed = 1; seed <= 3; seed++) {
      const input = fixture(seed);
      await noteStore.create(input);
      await noteStore.consume(input.id);
    }
    vi.setSystemTime(start.getTime() + 30 * day);
    expect(
      await Promise.all([
        noteStore.cleanupTombstones(30, 2),
        noteStore.cleanupTombstones(30, 2),
      ]),
    ).toEqual([2, 1]);
    expect(await noteStore.cleanupTombstones(30)).toBe(0);
    for (let seed = 4; seed <= 6; seed++)
      expect((await noteStore.create(fixture(seed))).kind).toBe("created");
    expect((await noteStore.create(fixture(7))).kind).toBe("storage-full");
  });

  it("removes and tombstones expired notes exactly once before reconciliation", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(start);
    const expired = fixture(1, new Date(start.getTime() + 1000));
    const active = fixture(2);
    await noteStore.create(expired);
    await noteStore.create(active);
    vi.setSystemTime(start.getTime() + 1000);
    await expect(noteStore.reconcile()).resolves.toEqual({
      activeNoteCount: 1,
      activePayloadBytes: 16,
    });
    vi.setSystemTime(start.getTime() + day);
    await noteStore.reconcile();
    expect(await noteStore.metadata(expired.id)).toBeNull();
    expect((await noteStore.consume(expired.id)).kind).toBe("unavailable");
    expect(await noteStore.cleanupExpired()).toEqual({
      deleted: 0,
      payloadBytes: 0,
    });
    expect((await noteStore.checkReplay(expired)).kind).toBe("replay");
    expect((await noteStore.consume(active.id)).kind).toBe("success");
    await expect(noteStore.stats()).resolves.toEqual({
      activeNoteCount: 0,
      activePayloadBytes: 0,
    });
    vi.setSystemTime(start.getTime() + 30 * day + 999);
    expect(await noteStore.cleanupTombstones(30)).toBe(0);
    vi.setSystemTime(start.getTime() + 30 * day + 1000);
    expect(await noteStore.cleanupTombstones(30)).toBe(1);
  });

  it("serializes concurrent last-slot admission and exact creates", async () => {
    vi.stubEnv("MAX_RETAINED_NOTE_COUNT", "1");
    resetEnvForTests();
    const input = fixture(1);
    const same = await Promise.all([
      noteStore.create(input),
      noteStore.create(input),
    ]);
    expect(same.map((r) => r.kind).sort()).toEqual(["created", "replay"]);
    await noteStore.resetForTests();
    const different = await Promise.all([
      noteStore.create(fixture(2)),
      noteStore.create(fixture(3)),
    ]);
    expect(different.map((r) => r.kind).sort()).toEqual([
      "created",
      "storage-full",
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid retention %s",
    async (days) => {
      await expect(noteStore.cleanupTombstones(days)).rejects.toThrow(
        "retention",
      );
    },
  );

  it.each([undefined, ""])(
    "defaults retained capacity when unset (%s)",
    (value) => {
      vi.stubEnv("MAX_RETAINED_NOTE_COUNT", value);
      resetEnvForTests();
      expect(getEnv().MAX_RETAINED_NOTE_COUNT).toBe(1_000_000);
    },
  );

  it.each(["0", "-1", "1.5", "Infinity", "9007199254740992"])(
    "rejects unsafe retained capacity %s",
    (value) => {
      vi.stubEnv("MAX_RETAINED_NOTE_COUNT", value);
      resetEnvForTests();
      expect(() => getEnv()).toThrow("MAX_RETAINED_NOTE_COUNT");
      vi.stubEnv("MAX_RETAINED_NOTE_COUNT", "3");
      resetEnvForTests();
    },
  );
});
