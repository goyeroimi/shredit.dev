import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const textExtensions = new Set([
  ".md",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".css",
  ".sql",
  ".html",
  ".svg",
  ".toml",
]);

export function privatePath(file) {
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const name = segments.at(-1);
  if (
    segments.some((part) =>
      ["_codex", "secrets", ".ssh", "backups"].includes(part),
    )
  )
    return "private-directory";
  if (name === "project_rules.md") return "local-operator-rules";
  if (/_ru\.md$/iu.test(name)) return "russian-public-document";
  if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example")
    return "private-environment";
  if ([".npmrc", ".netrc", ".git-credentials"].includes(name))
    return "credential-file";
  if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519))(?:\.|$)/u.test(name))
    return "ssh-key-file";
  if (
    /\.(?:pem|key|crt|p12|pfx|dump|sqlite3?|log|bak|backup)$/u.test(name) ||
    name.endsWith(".sql.gz")
  )
    return "private-material";
  if (
    segments.some((part) =>
      [
        "node_modules",
        ".next",
        "coverage",
        "test-results",
        "playwright-report",
      ].includes(part),
    )
  )
    return "generated-artifact";
  return undefined;
}

export function inspectText(file, bytes, privateValues = []) {
  const findings = [];
  const add = (rule, line = 1) => findings.push({ file, line, rule });
  const isText =
    !bytes.includes(0) ||
    textExtensions.has(path.extname(file).toLowerCase()) ||
    [
      "Dockerfile",
      ".env.example",
      ".gitignore",
      ".dockerignore",
      ".prettierignore",
      "LICENSE",
    ].includes(path.basename(file)) ||
    file.startsWith(".githooks/");
  const rawText = bytes.toString("utf8");
  for (const value of privateValues) {
    const offset = rawText.indexOf(value);
    if (offset !== -1)
      add("known-private-value", rawText.slice(0, offset).split("\n").length);
  }
  if (!isText) return findings;
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    add("invalid-utf8");
    return findings;
  }
  const rules = [
    ["replacement-character", /\uFFFD/u],
    [
      "unexpected-control",
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u,
    ],
    ["unpaired-surrogate", /[\uD800-\uDFFF]/u],
    [
      "mojibake",
      /(?:\u00C3[\u0080-\u00BF]|\u00C2[\u0080-\u00BF]|\u00E2\u20AC|(?:\u00D0|\u00D1)[\u0080-\u00BF]|\u951F\u65A4\u62F7|(?:\u0420[\u00A0-\u00BF\u0402-\u040F\u0452-\u045F]|\u0421[\u00A0-\u00BF\u0402-\u040F\u0452-\u045F]){2,})/u,
    ],
    ["private-key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u],
    [
      "provider-token",
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/u,
    ],
    ["private-workstation-path", /\b[A-Za-z]:[\\/](?:Users|Codex)[\\/]/iu],
  ];
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    for (const [rule, pattern] of rules)
      if (pattern.test(line)) add(rule, index + 1);
  }
  if (path.extname(file).toLowerCase() === ".json") {
    try {
      JSON.parse(source);
    } catch {
      add("invalid-json");
    }
  }
  if (path.extname(file).toLowerCase() === ".md") {
    const fences = [...source.matchAll(/^\s*```/gmu)].length;
    if (fences % 2 !== 0) add("unclosed-markdown-fence");
  }
  return findings;
}

export function inspectPublicLanguage(file, bytes) {
  if (bytes.includes(0)) return [];
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return [];
  }
  return source
    .split(/\r?\n/u)
    .flatMap((line, index) =>
      /[\u0400-\u052F]/u.test(line)
        ? [{ file, line: index + 1, rule: "forbidden-russian-copy" }]
        : [],
    );
}

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function splitNull(bytes) {
  return bytes.toString("utf8").split("\0").filter(Boolean);
}

function loadPrivateValues(root, policy) {
  const values = new Set(policy.forbiddenText || []);
  for (const relative of policy.secretFiles || []) {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`))
      throw new Error("Private input escapes project");
    if (!fs.existsSync(absolute)) continue;
    const content = fs.readFileSync(absolute, "utf8");
    if (relative.endsWith(".txt")) {
      const value = content.trim();
      if (value.length >= 8) values.add(value);
      continue;
    }
    for (const line of content.split(/\r?\n/u)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
      if (
        !match ||
        !/(?:SECRET|TOKEN|PASSWORD|DATABASE_URL|VALKEY_URL|WEBHOOK)/u.test(
          match[1],
        )
      )
        continue;
      const value = match[2].trim().replace(/^(["'])(.*)\1$/u, "$2");
      if (
        value.length < 8 ||
        policy.publicFixtureValues?.includes(value) ||
        value === "local-only-replace-with-random-32-byte-secret"
      )
        continue;
      if (
        /^(?:postgres(?:ql)?|rediss?):\/\/(?:[^@]+@)?(?:127\.0\.0\.1|localhost|postgres|valkey)(?::|\/)/u.test(
          value,
        )
      )
        continue;
      values.add(value);
      try {
        const url = new URL(value);
        if (url.password.length >= 8)
          values.add(decodeURIComponent(url.password));
      } catch {
        /* Not a URL. */
      }
    }
  }
  return [...values].filter((value) => value.length >= 4);
}

export function runCheck(root, { mode = "worktree", ref = "HEAD" } = {}) {
  root = path.resolve(root);
  const policyPath = path.join(
    root,
    "_codex",
    "ssh",
    "github-deploy",
    "private-checks.json",
  );
  const policy = fs.existsSync(policyPath)
    ? JSON.parse(fs.readFileSync(policyPath, "utf8"))
    : {};
  const privateValues = loadPrivateValues(root, policy);
  const findings = [];
  let commits = [];
  const seenBlobs = new Set();
  let filesChecked = 0;
  function inspect(file, bytes, modeBits) {
    const reason = privatePath(file);
    if (reason) findings.push({ file, line: 1, rule: reason });
    if (modeBits === "120000" || modeBits === "160000")
      findings.push({
        file,
        line: 1,
        rule: "symlink-or-submodule-review-required",
      });
    findings.push(...inspectText(file, bytes, privateValues));
    findings.push(...inspectPublicLanguage(file, bytes));
    filesChecked += 1;
  }
  if (mode === "history") {
    commits = git(root, ["rev-list", ref])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const commit of commits) {
      const metadata = git(root, [
        "show",
        "-s",
        "--format=%an%x00%ae%x00%cn%x00%ce%x00%B",
        commit,
      ]);
      findings.push(
        ...inspectText(
          `commit:${commit}.txt`,
          Buffer.from(metadata.toString().replaceAll("\0", "\n")),
          privateValues,
        ),
        ...inspectPublicLanguage(
          `commit:${commit}.txt`,
          Buffer.from(metadata.toString().replaceAll("\0", "\n")),
        ),
      );
      const [author, email, committer, committerEmail] = metadata
        .toString()
        .split("\0");
      if (
        policy.publicAuthorName &&
        [author, committer].some((value) => value !== policy.publicAuthorName)
      )
        findings.push({
          file: `commit:${commit}`,
          line: 1,
          rule: "unapproved-author-name",
        });
      if (
        policy.publicAuthorEmail &&
        [email, committerEmail].some(
          (value) => value !== policy.publicAuthorEmail,
        )
      )
        findings.push({
          file: `commit:${commit}`,
          line: 1,
          rule: "unapproved-author-email",
        });
      for (const record of splitNull(
        git(root, ["ls-tree", "-rz", "--full-tree", commit]),
      )) {
        const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/su.exec(record);
        if (!match) {
          findings.push({
            file: "git-tree",
            line: 1,
            rule: "unsupported-tree-entry",
          });
          continue;
        }
        const [, modeBits, oid, file] = match;
        const identity = `${file}:${oid}`;
        if (seenBlobs.has(identity)) continue;
        seenBlobs.add(identity);
        inspect(file, git(root, ["cat-file", "blob", oid]), modeBits);
      }
    }
  } else {
    for (const record of splitNull(git(root, ["ls-files", "--stage", "-z"]))) {
      const match = /^(\d+) ([a-f0-9]+) (\d)\t(.+)$/su.exec(record);
      if (!match) throw new Error("Unrecognized index entry");
      const [, modeBits, oid, stage, file] = match;
      if (stage !== "0")
        findings.push({ file, line: 1, rule: "unresolved-index" });
      if (mode === "staged")
        inspect(file, git(root, ["cat-file", "blob", oid]), modeBits);
      else {
        const absolute = path.resolve(root, file);
        if (!absolute.startsWith(`${root}${path.sep}`))
          throw new Error("Index path escapes project");
        if (fs.existsSync(absolute))
          inspect(file, fs.readFileSync(absolute), modeBits);
        else findings.push({ file, line: 1, rule: "tracked-file-missing" });
      }
    }
  }
  return {
    scope: mode,
    ref: mode === "history" ? ref : undefined,
    filesChecked,
    commitsChecked: commits.length,
    knownPrivateValuesChecked: privateValues.length,
    status: findings.length ? "BLOCKED" : "PASS",
    findings,
    limitations:
      "Pattern/exact-value checks only; manual review and an independent secret scanner are still required.",
  };
}

const invoked =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const args = process.argv.slice(2);
    if (
      args.some(
        (arg) =>
          !["--staged", "--history", "--ref"].includes(arg) &&
          args[args.indexOf(arg) - 1] !== "--ref",
      )
    )
      throw new Error("Unknown argument");
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"])
      .toString()
      .trim();
    const ref = args.includes("--ref")
      ? args[args.indexOf("--ref") + 1]
      : "HEAD";
    if (!ref || ref.startsWith("-")) throw new Error("Invalid history ref");
    const result = runCheck(root, {
      mode: args.includes("--history")
        ? "history"
        : args.includes("--staged")
          ? "staged"
          : "worktree",
      ref,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.findings.length) process.exitCode = 1;
  } catch {
    process.stderr.write(
      "Public repository check failed closed; inspect local configuration without printing secrets.\n",
    );
    process.exitCode = 1;
  }
}
