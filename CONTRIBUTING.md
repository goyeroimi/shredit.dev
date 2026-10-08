# Contributing to Shredit

## Propose and review a change

For a non-sensitive bug, open a
[GitHub issue](https://github.com/goyeroimi/shredit.dev/issues) with the affected
version, expected behavior, and a minimal reproduction using synthetic data.
Discuss substantial feature or protocol changes before implementing them.
For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a
public issue. Never include real notes, passwords, complete share links,
credentials, logs containing user data, or personal information.

Fork the repository, clone your fork, and work on a feature branch. The
[README](README.md#local-development) covers local setup. Use Node.js 22, pnpm 10,
the pinned lockfile, and local PostgreSQL/Valkey services only. Never point local
tests or migrations at production.

Open a pull request against upstream `master`. Explain the problem, the proposed
behavior, and the checks performed. Include sanitized before/after screenshots
for interface changes. A check you did not run should be marked as not run.

## Preserve the product contract

Read the [protocol specification](SHREDIT_PROJECT_SPEC.md),
[threat model](THREAT_MODEL.md), and
[implementation decisions](docs/IMPLEMENTATION_DECISIONS.md).

- Keep notes plain-text-only, account-free, and delivered at most once.
- Preserve browser encryption, URL-fragment privacy, explicit opening, and
  fail-closed access and anti-abuse controls.
- Do not add trackers, advertising, remote fonts, session replay, or logging of
  note content, keys, passwords, full links, or identifying request data.
- Do not promise absolute anonymity, guaranteed privacy, or an independent audit.
- Protocol-sensitive changes need regression tests and an explanation in
  `docs/IMPLEMENTATION_DECISIONS.md`. Do not rewrite the frozen specification to
  make an incompatible implementation appear compliant.

Public repository documentation is English. The supported interface locales are
English and Simplified Chinese; preserve both. Russian documentation, comments,
reports, filenames, and interface copy must not be published. Keep private
operator reports outside the public repository.

## Run the checks

```sh
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
pnpm run repository:check
```

For interface changes, check both supported languages, light and dark themes,
keyboard navigation, focus, clipboard failure, and narrow screens. Use only
synthetic messages and do not send automated activity to analytics.

## Keep publication safe

Stage an explicit list of intended files and review the staged diff. Then run:

```sh
pnpm run repository:check:staged
```

To enable the supplied local Git hooks:

```sh
git config --local core.hooksPath .githooks
```

The hooks reject detected private files/secrets before committing and check
outgoing history before pushing. They are a local safeguard, not a guarantee
that arbitrary sensitive text can be recognized. Never force-add private files
or bypass a failing check.

Install Gitleaks separately from its official release to run the independent
scanner. With `gitleaks` on `PATH`, the hooks use the default rules plus the
project's narrowly reviewed synthetic-fixture exceptions in `.gitleaks.toml`.
Without it, the Node.js safeguard still runs; perform the independent scan
before a public release. Do not widen fixture exceptions to hide a new finding.

Alternatively, configure `shredit.gitleaksPath` locally with the absolute path
to your verified executable. Set `shredit.requireGitleaks=true` locally to fail
closed when the independent scanner is unavailable; upstream publishing requires
this stricter mode. These local Git settings do not transfer to forks.

Never commit environment files other than the reviewed `.env.example`, keys,
database backups, production logs, `_codex/`, or any `project_rules.md` file.
If a secret has already been exposed, rotate it and coordinate cleanup; an
ignore rule does not remove it from history. See the
[fork guide](docs/FORKING.md) for independent identities, secrets, contacts,
deployment responsibilities, and licensing.

## License

Contributions must preserve the project's [AGPL-3.0-only license](LICENSE),
copyright notices, and corresponding-source obligations. A merge into a
provider-connected branch may deploy automatically; publication and production
operations remain maintainer decisions, not side effects to trigger from a fork.
