# Forking and self-hosting Shredit

## 1. Create an independent fork

Fork [goyeroimi/shredit.dev](https://github.com/goyeroimi/shredit.dev) in
GitHub, then clone your own fork's `master` branch. Work on a feature branch
and send a pull request to upstream `master`. Do not use the upstream
operator's credentials or copy their private working directory.

Set repository-local `user.name` and `user.email` to your intended public author
identity. Git commits expose author and committer names/emails; use your GitHub
account's actual noreply address from its email settings if you do not want to
publish a personal email. This affects future commits, not existing history.
Avoid importing unrelated history or attaching private logs to issues.

The [README](../README.md) covers local setup. Install from the pinned lockfile,
use Node.js 22 and pnpm 10, and keep all development databases local.

## 2. Keep secrets and operator information private

- `.env.local` and all other non-example environment files stay local.
- `_codex/` is a private operational workspace, never public source or build input.
- Every `project_rules.md`, including nested/case-variant copies, is local-only.
- Private keys, `.npmrc` credentials, logs, database dumps, screenshots containing
  user data, and infrastructure access instructions must never be committed.
- Generate independent values for all HMAC/PoW secrets and the production ingress
  token. Do not use the local Compose password, test fixtures, or template values
  in a publicly accessible instance.
- Keep server secrets out of `NEXT_PUBLIC_*`, Docker labels, browser bundles,
  shell transcripts, and public issue attachments.

Enable the optional local hooks with `git config --local core.hooksPath .githooks`.
Run `pnpm run repository:check` while working, stage an explicit list of files,
and run `pnpm run repository:check:staged` before each commit. The staged check
reads the Git index, not just the current file on disk. The push hook checks all
reachable outgoing commits as well. If a secret was committed or published,
rotate it first and coordinate history cleanup; adding an ignore rule does not
remove it from history. Automated scans have limits: manually review the diff.

Run an independent Gitleaks scan before public publication. The hooks also run
it when its official executable is on `PATH`. `.gitleaks.toml` keeps default
rules and only exact, path-scoped exceptions for reviewed non-secret examples;
do not widen those exceptions to make an unexpected finding disappear.

Use an independent SSH deploy key for each repository/role. Add only its public
half to your fork; restrict private-key filesystem access. A provider clone key
should be read-only. A maintainer push key can have repository-scoped write
access. Never use another person's key or rely on a default identity fallback.

## 3. Configure your instance, not the upstream instance

| Setting                                           | Fork requirement                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `PUBLIC_BASE_URL`                                 | Your canonical HTTPS origin; local development uses loopback.            |
| `GIT_REPOSITORY_URL`                              | Your public fork URL without credentials, query, fragment, or `.git`.    |
| `NEXT_PUBLIC_GIT_COMMIT`                          | The exact Git revision used to build your release.                       |
| `PUBLIC_REPOSITORY_LINKS_ENABLED`                 | Enable after that exact revision is public in the configured repository. |
| `SECURITY_CONTACT`, `ABUSE_CONTACT`               | Channels controlled by your operator, not upstream contacts.             |
| `SECURITY_POLICY_URL`, `ABUSE_POLICY_URL`         | Corresponding policy routes on your own canonical origin.                |
| `DATABASE_URL`, `VALKEY_URL`                      | Your independently provisioned authenticated services.                   |
| `INGRESS_AUTH_TOKEN` or `INGRESS_AUTH_TOKEN_FILE` | Exactly one source for a new random 32-byte unpadded base64url token.    |
| `TRUSTED_PROXY_CIDRS`                             | Controlled upstream forwarding networks for your topology.               |
| `MAX_ACTIVE_NOTE_BYTES`, `MAX_ACTIVE_NOTE_COUNT`  | Deliberate finite limits appropriate for your capacity.                  |

Set optional Turnstile keys, GeoIP data, and onion configuration only when using
those features. Disable unused features explicitly. Never share the upstream
onion service's persistent key. Do not enable repository links until Git-hosted
security/abuse channels also use the intended identity.

The public issue-template contact URL still points to upstream for code
vulnerabilities; update it and enable GitHub private vulnerability reporting if
you maintain a fork-specific security channel. Public issues are not a private
disclosure mechanism. Instance incidents should go to that instance's operator.

## 4. Deploy deliberately

Read [the deployment guide](DEPLOYMENT.md) before exposure. Build the Dockerfile
`runner` target; run migrations and capacity reconciliation once as a release
job using the `maintenance` target. Schedule expired-note cleanup with a single
worker every five minutes. Keep the application port private behind trusted
ingress, stamp authenticated surface headers, require production PostgreSQL TLS,
and use authenticated/protected Valkey transport.

For upstream, `master` is the intended repository branch. An existing
production provider is not automatically migrated by changing a local remote.
For a fork, choose your own deployment branch and provider explicitly. Once
connected, a push may immediately deploy: obtain your operator's approval first.
Do not expose `_codex/`, private rules, or secrets in build/upload artifacts.

Validate liveness and readiness without consuming user notes, then test the
create/open lifecycle with synthetic data only. Page previews must not consume
notes. Test concurrency, wrong-password behavior, expiration, rate limits, CSP,
uncached responses, spoofed ingress headers, and both locales. Never perform
tests against another person's notes or send synthetic tracking events to live
analytics. Source-commit metadata is not proof of binary/browser-code equivalence.

## 5. Preserve product and license boundaries

Review [the threat model](../THREAT_MODEL.md),
[security policy](../SECURITY.md), and
[implementation decisions](IMPLEMENTATION_DECISIONS.md). Do not weaken
one-time delivery, fragment privacy, origin checks, or fail-closed anti-abuse.
Do not claim absolute anonymity, guaranteed privacy, or an independent audit.

The project is licensed under [AGPL-3.0-only](../LICENSE). Preserve notices and
offer the corresponding source to network users when the license requires it.
Review your own branding, trademark, legal copy, reporting channels, retention,
and operational responsibilities; copying the upstream configuration does not
establish legal compliance or a secure production deployment.
