import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWebCryptoCapability,
  decryptNote,
  encryptNote,
  parseNoteLocation,
  toBase64Url,
} from "@/lib/client-crypto";
import {
  classifyOpenNoteFailure,
  classifyPreparedRequestFailure,
  postOpenNoteAfterCryptoPreflight,
  preparedRequestAfterCreateFailure,
  preparedRequestForAntiAbuseRefresh,
  type PreparedRequest,
} from "@/components/shredit-ui";

const NOTE_ID = toBase64Url(new Uint8Array(24).fill(7));
const OTHER_NOTE_ID = toBase64Url(new Uint8Array(24).fill(8));
const KEY = toBase64Url(new Uint8Array(32).fill(9));
const uiSource = readFileSync(
  new URL("../components/shredit-ui.tsx", import.meta.url),
  "utf8",
);

function stubNoteWindow() {
  const location = {
    pathname: `/n/${NOTE_ID}`,
    search: "",
    hash: `#v1.${KEY}`,
  };
  const replaceState = vi.fn();
  vi.stubGlobal("window", { location, history: { replaceState } });
  return { location, replaceState };
}

function pauseCryptoPreflight() {
  const realCrypto = globalThis.crypto;
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.stubGlobal("crypto", {
    getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    subtle: {
      importKey: async (...args: Parameters<SubtleCrypto["importKey"]>) => {
        await paused;
        return realCrypto.subtle.importKey(...args);
      },
      encrypt: realCrypto.subtle.encrypt.bind(realCrypto.subtle),
      decrypt: realCrypto.subtle.decrypt.bind(realCrypto.subtle),
    },
  });
  return resume;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client AES-GCM protocol", () => {
  it("passes the deterministic WebCrypto capability preflight", async () => {
    await expect(assertWebCryptoCapability()).resolves.toBeUndefined();
  });

  it("round-trips UTF-8 plaintext with AES-256-GCM", async () => {
    const plaintext = "Read once. \u79c1\u5bc6\u30e1\u30e2.";
    const encrypted = await encryptNote(NOTE_ID, plaintext);

    await expect(
      decryptNote(NOTE_ID, encrypted.key, encrypted.iv, encrypted.ciphertext),
    ).resolves.toBe(plaintext);
  });

  it("rejects ciphertext when the note ID changes the authenticated data", async () => {
    const encrypted = await encryptNote(NOTE_ID, "bound to one note ID");

    await expect(
      decryptNote(
        OTHER_NOTE_ID,
        encrypted.key,
        encrypted.iv,
        encrypted.ciphertext,
      ),
    ).rejects.toThrow();
  });

  it("rejects a malformed AES key", async () => {
    const encrypted = await encryptNote(NOTE_ID, "secret");
    const shortKey = toBase64Url(new Uint8Array(31));

    await expect(
      decryptNote(NOTE_ID, shortKey, encrypted.iv, encrypted.ciphertext),
    ).rejects.toThrow("malformed-payload");
  });
});

describe("note fragment parsing", () => {
  it("accepts the canonical v1 note location", () => {
    expect(parseNoteLocation(`/n/${NOTE_ID}`, "", `#v1.${KEY}`)).toEqual({
      id: NOTE_ID,
      key: KEY,
    });
  });

  it("returns null for an unsupported protocol version", () => {
    expect(parseNoteLocation(`/n/${NOTE_ID}`, "", `#v2.${KEY}`)).toBeNull();
  });

  it.each([
    ["query string", `/n/${NOTE_ID}`, "?source=preview", `#v1.${KEY}`],
    ["trailing slash", `/n/${NOTE_ID}/`, "", `#v1.${KEY}`],
    ["malformed key", `/n/${NOTE_ID}`, "", "#v1.not-a-key"],
    ["noncanonical key", `/n/${NOTE_ID}`, "", `#v1.${"_".repeat(43)}`],
  ])(
    "returns null without throwing for a %s",
    (_label, pathname, search, hash) => {
      expect(() => parseNoteLocation(pathname, search, hash)).not.toThrow();
      expect(parseNoteLocation(pathname, search, hash)).toBeNull();
    },
  );
});

describe("destructive open preflight", () => {
  it("does not send the consume request when WebCrypto is unavailable", async () => {
    vi.stubGlobal("crypto", { getRandomValues: vi.fn() });
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));

    await expect(
      postOpenNoteAfterCryptoPreflight(NOTE_ID, "", fetcher),
    ).rejects.toThrow("crypto-unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["missing fragment", `/n/${NOTE_ID}`, "", ""],
    ["invalid fragment", `/n/${NOTE_ID}`, "", "#main-content"],
    ["noncanonical key", `/n/${NOTE_ID}`, "", `#v1.${"_".repeat(43)}`],
    ["query string", `/n/${NOTE_ID}`, "?source=preview", `#v1.${KEY}`],
    ["different note", `/n/${OTHER_NOTE_ID}`, "", `#v1.${KEY}`],
    ["different path", "/", "", `#v1.${KEY}`],
  ])(
    "never POSTs from a current %s",
    async (_label, pathname, search, hash) => {
      const { location } = stubNoteWindow();
      Object.assign(location, { pathname, search, hash });
      const fetcher = vi.fn();
      await expect(
        postOpenNoteAfterCryptoPreflight(NOTE_ID, "", fetcher),
      ).rejects.toThrow("invalid-note-location");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["hash", ""],
    ["hash", "#v1.invalid"],
    ["search", "?unexpected=true"],
    ["pathname", `/n/${OTHER_NOTE_ID}`],
  ] as const)(
    "rechecks %s after the crypto preflight awaits",
    async (field, value) => {
      const { location, replaceState } = stubNoteWindow();
      const resume = pauseCryptoPreflight();
      const fetcher = vi.fn();
      const opening = postOpenNoteAfterCryptoPreflight(NOTE_ID, "", fetcher);
      const rejected = expect(opening).rejects.toThrow("invalid-note-location");
      expect(fetcher).not.toHaveBeenCalled();
      location[field] = value;
      resume();
      await rejected;
      expect(fetcher).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
    },
  );

  it("uses a corrected valid key at POST time, not the mounted or later key", async () => {
    const encrypted = await encryptNote(NOTE_ID, "corrected fragment");
    const { location } = stubNoteWindow();
    const resume = pauseCryptoPreflight();
    const fetcher = vi.fn(async () => {
      location.hash = `#v1.${KEY}`;
      return Response.json({ id: NOTE_ID, protocolVersion: 1, ...encrypted });
    });
    const opening = postOpenNoteAfterCryptoPreflight(
      NOTE_ID,
      "e\u0301-password",
      fetcher,
    );
    location.hash = `#v1.${encrypted.key}`;
    resume();
    const { response, key } = await opening;
    expect(key).toBe(encrypted.key);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/notes/${NOTE_ID}/open`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "\u00e9-password" }),
        cache: "no-store",
      },
    );
    const payload = await response.json();
    await expect(
      decryptNote(NOTE_ID, key, payload.iv, payload.ciphertext),
    ).resolves.toBe("corrected fragment");
  });

  it.each([400, 401, 403, 408, 409, 410, 422, 429, 500, 502, 503, 504])(
    "retains the fragment for retry after HTTP %i",
    async (status) => {
      const encrypted = await encryptNote(NOTE_ID, "retry plaintext");
      const { location, replaceState } = stubNoteWindow();
      location.hash = `#v1.${encrypted.key}`;
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(Response.json(encrypted));
      const first = await postOpenNoteAfterCryptoPreflight(
        NOTE_ID,
        "",
        fetcher,
      );
      expect(classifyOpenNoteFailure(first.response.status, false).state).toBe(
        "transport",
      );
      expect(location.hash).toBe(`#v1.${encrypted.key}`);
      expect(replaceState).not.toHaveBeenCalled();
      const retry = await postOpenNoteAfterCryptoPreflight(
        NOTE_ID,
        "",
        fetcher,
      );
      const payload = await retry.response.json();
      await expect(
        decryptNote(NOTE_ID, retry.key, payload.iv, payload.ciphertext),
      ).resolves.toBe("retry plaintext");
    },
  );

  it("retains the key after a transport error and permits a later retry", async () => {
    const { location, replaceState } = stubNoteWindow();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response());
    await expect(
      postOpenNoteAfterCryptoPreflight(NOTE_ID, "", fetcher),
    ).rejects.toThrow();
    expect(location.hash).toBe(`#v1.${KEY}`);
    expect(replaceState).not.toHaveBeenCalled();
    await expect(
      postOpenNoteAfterCryptoPreflight(NOTE_ID, "", fetcher),
    ).resolves.toMatchObject({ key: KEY });
  });
});

describe("open response authority", () => {
  it("treats every unrecognized HTTP failure as retryable", () => {
    for (let status = 300; status <= 599; status += 1) {
      if (status === 404 || status === 429) continue;
      for (const requiresPassword of [false, true]) {
        expect(classifyOpenNoteFailure(status, requiresPassword)).toEqual({
          state: "transport",
          errorKey: "serviceUnavailable",
        });
      }
    }
  });

  it("requires authoritative metadata before clearing a protected 404", () => {
    expect(classifyOpenNoteFailure(404, false)).toEqual({
      state: "unavailable",
      errorKey: null,
    });
    expect(classifyOpenNoteFailure(404, true, { kind: "unavailable" })).toEqual(
      {
        state: "unavailable",
        errorKey: null,
      },
    );
    expect(
      classifyOpenNoteFailure(404, true, {
        kind: "ready",
        requiresPassword: true,
      }),
    ).toEqual({
      state: "wrong",
      errorKey: "wrongPassword",
    });
    for (const meta of [
      undefined,
      { kind: "retry" },
      { kind: "ready", requiresPassword: false },
    ] as const) {
      expect(classifyOpenNoteFailure(404, true, meta)).toEqual({
        state: "transport",
        errorKey: "serviceUnavailable",
      });
    }
  });

  it("preserves the existing rate-limit feedback for both gates", () => {
    expect(classifyOpenNoteFailure(429, true)).toEqual({
      state: "wrong",
      errorKey: "tooManyAttempts",
    });
    expect(classifyOpenNoteFailure(429, false)).toEqual({
      state: "transport",
      errorKey: "tooManyAttempts",
    });
  });
});

describe("client lifecycle source guards", () => {
  const composer = uiSource.slice(
    uiSource.indexOf("export function NoteComposer("),
    uiSource.indexOf("function ShareLinkRow("),
  );
  const opener = uiSource.slice(
    uiSource.indexOf("export function OpenNoteGate("),
    uiSource.indexOf("export function TorLink("),
  );

  it("locks every payload control throughout encryption, PoW, creation and prepared retries", () => {
    expect(composer).toMatch(
      /const requestLocked =\s*prepared !== null \|\|\s*status === "encrypting" \|\|\s*status === "pow" \|\|\s*status === "creating"/u,
    );
    for (const marker of [
      "<textarea",
      "<ExpirySelect",
      'id="password-toggle"',
      "<PasswordControl",
    ]) {
      const control = composer.slice(composer.indexOf(marker));
      expect(control.slice(0, control.indexOf("disabled=") + 80)).toContain(
        "disabled={requestLocked",
      );
    }
  });

  it("captures one payload snapshot before awaiting and reuses it on collision", () => {
    const prepare = composer.slice(
      composer.indexOf("async function prepareRequest("),
      composer.indexOf("async function submit("),
    );
    expect(prepare).toContain("const { text, password, expiry } = snapshot;");
    expect(prepare).not.toContain("passwordEnabled");
    expect(prepare.indexOf("= snapshot;")).toBeLessThan(
      prepare.indexOf("await encryptNote"),
    );
    const submit = composer.slice(
      composer.indexOf("async function submit("),
      composer.indexOf("function startOver("),
    );
    expect(submit).toMatch(
      /const snapshot = \{\s*text,\s*password: passwordEnabled \? normalizePassword\(password\) : undefined,\s*expiry,\s*\};/u,
    );
    expect(submit.indexOf("const snapshot =")).toBeLessThan(
      submit.indexOf("await "),
    );
    expect(submit.match(/await prepareRequest\(snapshot\)/gu)).toHaveLength(2);
    expect(submit).not.toContain("prepareRequest()");
  });

  it("guards duplicate submissions synchronously and unlocks retryable failures in finally", () => {
    for (const [source, lock, firstAwait] of [
      [composer, "submitLockedRef", "request = await prepareRequest(snapshot)"],
      [
        opener,
        "openLockedRef",
        "const { response, key } = await postOpenNoteAfterCryptoPreflight",
      ],
    ]) {
      expect(source).toContain(`const ${lock} = useRef(false)`);
      expect(source).toMatch(new RegExp(`if \\(\\s*${lock}\\.current`));
      expect(source.indexOf(`${lock}.current = true`)).toBeLessThan(
        source.indexOf(firstAwait),
      );
      expect(source).toMatch(
        new RegExp(`finally \\{[\\s\\S]*?${lock}\\.current = false`),
      );
    }
    expect(composer).toContain(
      "if (!succeeded) submitLockedRef.current = false;",
    );
    expect(opener).toContain(
      "if (!consumed && !unavailable) openLockedRef.current = false;",
    );
    expect(composer).toMatch(
      /function startOver\(\) \{\s*if \(submitLockedRef.current\) return;/u,
    );
  });

  it("clears only confirmed unavailable or consumed notes, never state-driven unknown failures", () => {
    expect(opener).not.toContain("setKey");
    expect(opener).toContain(
      'if (meta.kind === "unavailable") clearNoteFragment(id);',
    );
    expect(opener).toContain('unavailable = failure.state === "unavailable";');
    expect(opener).toContain("if (unavailable) clearNoteFragment(noteId);");
    expect(opener).toMatch(
      /consumed = true;\s*clearNoteFragment\(noteId\);\s*setPassword\(""\);\s*const payload = await response.json/u,
    );
    expect(opener).toMatch(
      /const plaintext = await decryptNote\(\s*noteId,\s*key,/u,
    );
    const clear = uiSource.slice(
      uiSource.indexOf("function clearNoteFragment("),
      uiSource.indexOf("type CreationResult"),
    );
    expect(clear).toContain("if (window.location.pathname === `/n/${noteId}`)");
  });
});

describe("prepared create request retry policy", () => {
  it.each([
    [409, "IDEMPOTENCY_CONFLICT"],
    [400, "INVALID_REQUEST"],
  ])("preserves the prepared request after %i %s", (status, code) => {
    expect(classifyPreparedRequestFailure(status, code)).toBe("preserve");
  });

  it("regenerates only for an explicit note ID conflict", () => {
    expect(classifyPreparedRequestFailure(409, "NOTE_ID_CONFLICT")).toBe(
      "regenerate",
    );
    expect(classifyPreparedRequestFailure(500, "NOTE_ID_CONFLICT")).toBe(
      "preserve",
    );
    expect(classifyPreparedRequestFailure(503, "NOTE_ID_CONFLICT")).toBe(
      "refresh-proof",
    );
  });

  it("refreshes proof material for retryable responses that may consume it", () => {
    expect(classifyPreparedRequestFailure(403, "ANTI_ABUSE_FAILED")).toBe(
      "refresh-proof",
    );
    expect(classifyPreparedRequestFailure(429, "RATE_LIMITED")).toBe(
      "refresh-proof",
    );
    expect(classifyPreparedRequestFailure(503, "DEPENDENCY_UNAVAILABLE")).toBe(
      "refresh-proof",
    );
    expect(classifyPreparedRequestFailure(507, "STORAGE_FULL")).toBe(
      "refresh-proof",
    );
    expect(classifyPreparedRequestFailure(507)).toBe("refresh-proof");
    expect(classifyPreparedRequestFailure("network")).toBe("refresh-proof");
  });

  it.each([
    [429, "RATE_LIMITED"],
    [503, "DEPENDENCY_UNAVAILABLE"],
    [507, "STORAGE_FULL"],
  ])(
    "keeps the core request, AES key, and idempotency key while refreshing proof after %i %s",
    (status, code) => {
      const body = {
        id: NOTE_ID,
        protocolVersion: 1,
        iv: "fixed-iv",
        ciphertext: "fixed-ciphertext",
        expiresIn: "7d",
        password: "fixed-password",
        turnstileToken: "one-use-token",
        pow: { challenge: "one-use-challenge", nonce: "nonce" },
      };
      const prepared: PreparedRequest = {
        body,
        id: NOTE_ID,
        key: KEY,
        idempotencyKey: "fixed-idempotency-key",
      };

      const retained = preparedRequestAfterCreateFailure(
        prepared,
        status,
        code,
      );
      expect(retained).not.toBe(prepared);
      expect(retained?.id).toBe(prepared.id);
      expect(retained?.body).toMatchObject({
        id: NOTE_ID,
        protocolVersion: 1,
        iv: "fixed-iv",
        ciphertext: "fixed-ciphertext",
        expiresIn: "7d",
        password: "fixed-password",
      });
      expect(retained?.body).not.toHaveProperty("turnstileToken");
      expect(retained?.body).not.toHaveProperty("pow");
      expect(retained?.key).toBe(KEY);
      expect(retained?.idempotencyKey).toBe("fixed-idempotency-key");
      expect(retained?.antiAbuseRefreshRequired).toBe(true);
    },
  );

  it("keeps the core request after an ambiguous create network failure", () => {
    const prepared: PreparedRequest = {
      body: {
        id: NOTE_ID,
        protocolVersion: 1,
        iv: "fixed-iv",
        ciphertext: "fixed-ciphertext",
        expiresIn: "never",
        turnstileToken: "one-use-token",
      },
      id: NOTE_ID,
      key: KEY,
      idempotencyKey: "fixed-idempotency-key",
    };

    const retained = preparedRequestAfterCreateFailure(prepared, "network");
    expect(retained).toEqual({
      ...prepared,
      body: {
        id: NOTE_ID,
        protocolVersion: 1,
        iv: "fixed-iv",
        ciphertext: "fixed-ciphertext",
        expiresIn: "never",
      },
      antiAbuseRefreshRequired: true,
    });
  });

  it("refreshes only anti-abuse proof material after proof rejection", () => {
    const prepared: PreparedRequest = {
      body: {
        id: NOTE_ID,
        protocolVersion: 1,
        iv: "fixed-iv",
        ciphertext: "fixed-ciphertext",
        expiresIn: "7d",
        turnstileToken: "one-use-token",
        pow: { challenge: "one-use-challenge", nonce: "nonce" },
      },
      id: NOTE_ID,
      key: KEY,
      idempotencyKey: "fixed-idempotency-key",
    };

    const refreshed = preparedRequestForAntiAbuseRefresh(prepared);
    expect(refreshed.id).toBe(prepared.id);
    expect(refreshed.key).toBe(prepared.key);
    expect(refreshed.idempotencyKey).toBe(prepared.idempotencyKey);
    expect(refreshed.body.ciphertext).toBe(prepared.body.ciphertext);
    expect(refreshed.body).not.toHaveProperty("turnstileToken");
    expect(refreshed.body).not.toHaveProperty("pow");
    expect(refreshed.antiAbuseRefreshRequired).toBe(true);
  });
});
