import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectText,
  inspectPublicLanguage,
  privatePath,
  runCheck,
} from "../scripts/check-public-repository.mjs";

describe("public repository safeguards", () => {
  it.each([
    "_codex/ssh/identity",
    "nested/_codex/evidence/report.json",
    "Project_Rules.MD",
    "nested/PROJECT_RULES.md",
    ".env.local",
    "nested/.env.production",
    "nested/id_ed25519",
    "key.pem",
    ".npmrc",
    "backup.dump",
    "events.log",
    "README_ru.md",
    "docs/FORKING_RU.MD",
    "node_modules/package/index.js",
  ])("blocks private material at %s", (file) => {
    expect(privatePath(file)).toBeTruthy();
  });

  it.each([
    ".env.example",
    "nested/.env.example",
    "README.md",
    "drizzle/0000_initial.sql",
    "public/favicon.ico",
  ])("permits intended source path %s", (file) =>
    expect(privatePath(file)).toBeUndefined(),
  );

  it("validates actual ignore rules, including future misplaced keys and nested rules", () => {
    const paths = [
      "_codex/ssh/id_ed25519",
      "nested/_codex/log.txt",
      "nested/Project_Rules.MD",
      ".env.local",
      "id_ed25519",
      ".npmrc",
      "data.dump",
    ];
    const output = execFileSync("git", [
      "check-ignore",
      "--no-index",
      ...paths,
    ]).toString();
    expect(output.trim().split(/\r?\n/u)).toEqual(paths);
  });

  it("preserves valid English and Chinese UTF-8 text", () => {
    expect(
      inspectText("README.md", Buffer.from("Privacy and security. 中文说明\n")),
    ).toEqual([]);
  });

  it("rejects Russian public text without corrupting intentional Chinese", () => {
    const fixture = String.fromCodePoint(0x0420, 0x0443, 0x0441);
    expect(inspectPublicLanguage("README.md", Buffer.from(fixture))).toEqual([
      { file: "README.md", line: 1, rule: "forbidden-russian-copy" },
    ]);
    expect(
      inspectPublicLanguage("lib/messages.ts", Buffer.from("中文说明")),
    ).toEqual([]);
    expect(
      inspectPublicLanguage("public/icon.png", Buffer.from([0, 0xd0, 0xa0])),
    ).toEqual([]);
  });

  it("fails malformed UTF-8 and a replacement code point", () => {
    expect(inspectText("README.md", Buffer.from([0xc3, 0x28]))[0].rule).toBe(
      "invalid-utf8",
    );
    expect(
      inspectText("README.md", Buffer.from(String.fromCodePoint(0xfffd)))[0]
        .rule,
    ).toBe("replacement-character");
  });

  it("rejects unexpected controls and common conversion damage", () => {
    expect(
      inspectText("README.md", Buffer.from("broken\x07text"))[0].rule,
    ).toBe("unexpected-control");
    expect(
      inspectText("README.md", Buffer.from(String.fromCodePoint(0xc3, 0xa9)))[0]
        .rule,
    ).toBe("mojibake");
  });

  it("reports secret locations without printing secret values", () => {
    const value = ["synthetic", "private", "value"].join("-");
    const findings = inspectText("README.md", Buffer.from(`safe\n${value}\n`), [
      value,
    ]);
    expect(findings).toEqual([
      { file: "README.md", line: 2, rule: "known-private-value" },
    ]);
    expect(JSON.stringify(findings)).not.toContain(value);
  });

  it("detects private key material and provider tokens", () => {
    const privateHeader = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(
      " ",
    );
    expect(inspectText("README.md", Buffer.from(privateHeader))[0].rule).toBe(
      "private-key",
    );
    const token = `gh${"p_"}${"x".repeat(36)}`;
    expect(
      inspectText("config.json", Buffer.from(JSON.stringify({ token })))[0]
        .rule,
    ).toBe("provider-token");
  });

  it("rejects broken JSON and Markdown fences", () => {
    expect(inspectText("config.json", Buffer.from("{"))[0].rule).toBe(
      "invalid-json",
    );
    expect(
      inspectText("README.md", Buffer.from("```sh\ncommand\n"))[0].rule,
    ).toBe("unclosed-markdown-fence");
  });

  it("checks staged blobs and historical trees even when a private file was removed later", () => {
    const tempRoot = process.env.CODEX_ARTIFACT_DIR || tmpdir();
    const root = mkdtempSync(path.join(tempRoot, "repository-guard-test-"));
    const git = (...args) =>
      execFileSync("git", args, { cwd: root, stdio: "pipe" });
    try {
      git("init", "--initial-branch=developer");
      git("config", "user.name", "Synthetic Test");
      git("config", "user.email", "synthetic@example.invalid");
      git("config", "commit.gpgsign", "false");
      git("config", "core.hooksPath", ".disabled-hooks");
      writeFileSync(path.join(root, "README.md"), "# Safe\n");
      git("add", "README.md");
      expect(runCheck(root, { mode: "staged" }).status).toBe("PASS");
      git("commit", "-m", "synthetic initial");
      mkdirSync(path.join(root, "_codex"));
      writeFileSync(
        path.join(root, "_codex", "secret.txt"),
        "synthetic fixture only\n",
      );
      git("add", "_codex/secret.txt");
      expect(runCheck(root, { mode: "staged" }).status).toBe("BLOCKED");
      git("commit", "-m", "synthetic unsafe path");
      git("rm", "_codex/secret.txt");
      git("commit", "-m", "synthetic remove private file");
      expect(runCheck(root, { mode: "staged" }).status).toBe("PASS");
      const history = runCheck(root, { mode: "history" });
      expect(history.commitsChecked).toBe(3);
      expect(
        history.findings.some((item) => item.rule === "private-directory"),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps private folders and credential filenames outside the Docker context", () => {
    const dockerignore = readFileSync(".dockerignore", "utf8");
    for (const entry of [
      "**/_codex",
      "**/.env.*",
      "**/*.pem",
      "**/id_ed25519*",
      "**/secrets",
      "**/.npmrc",
      "**/*.dump",
    ])
      expect(dockerignore.split(/\r?\n/u)).toContain(entry);
  });
});
