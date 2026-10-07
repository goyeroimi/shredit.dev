# Shredit

Read once. Shred forever.

Shredit is an account-free, plain-text sharing application. The browser encrypts
notes with AES-256-GCM before upload; the decryption key stays in the share URL's
fragment. An explicit successful open atomically consumes the server-side note.
Page loads, metadata requests, and link previews do not consume it.

- Plain-text notes up to 64 KiB, with optional password gating.
- Expiry options: one hour, 24 hours, seven days, 30 days, or never.
- English and Simplified Chinese interfaces; light and dark themes.
- PostgreSQL storage, Valkey rate limiting, optional Turnstile and onion transport.
- No accounts, trackers, advertising, remote fonts, files, or recovery feature.

This is source available for review, not a claim of an independent audit. A
recipient can copy or photograph a note; a compromised endpoint or modified
client can expose its content. A failed decryption after a successful consume can
make the note permanently unavailable. See [the threat model](THREAT_MODEL.md).

## Repository

The upstream repository is
[goyeroimi/shredit.dev](https://github.com/goyeroimi/shredit.dev), branch
`master`. An operator chooses a deployment separately; a branch name or a
footer commit link does not prove what code is running on an instance.

## Local development

Requirements: Node.js 22, pnpm 10 (`10.12.4` is recorded in `package.json`), and
Docker Compose v2 for the supplied local PostgreSQL/Valkey services.

```sh
git clone --branch master --single-branch https://github.com/goyeroimi/shredit.dev.git
cd shredit.dev
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env.local` using your editor or file manager. It is a
local-only template, not a production configuration. Generate independent values
for `IP_HASH_SECRET`, `POW_SECRET`, and `IDEMPOTENCY_HMAC_SECRET` with the command
below, running it separately for each value, and paste them only into the ignored
`.env.local` file. Do not paste them into an issue or commit.

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url') + '\n')"
docker compose -f docker-compose.local.yml up -d postgres valkey
pnpm run db:migrate
pnpm run db:reconcile-capacity
pnpm run dev
```

Open [http://127.0.0.1:3232](http://127.0.0.1:3232), matching the configured local
origin. Never point local migrations or tests at a production database. The
Compose password and template placeholders are disposable local fixtures only.

## Checks and contributions

```sh
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
pnpm run repository:check
```

Before a commit, stage an explicit list of intended files and run
`pnpm run repository:check:staged`. To enable the supplied local Git hooks:

```sh
git config --local core.hooksPath .githooks
```

The hooks reject detected private files/secrets before committing and check
outgoing history before pushing. They are a local safeguard, not a guarantee
that arbitrary sensitive text can be recognized. Never use force-add or bypass
a failing check. Security-sensitive protocol changes need regression tests.

Install Gitleaks separately from its official release if you want the hooks to
also run its independent scanner. With `gitleaks` on `PATH`, the hooks use the
default detection rules plus the project's narrowly reviewed synthetic-fixture
exceptions in `.gitleaks.toml`. Without it, the Node.js safeguard still runs;
perform the independent scan before a public release.

Alternatively, configure `shredit.gitleaksPath` locally with an absolute path to
your verified executable. Set `shredit.requireGitleaks=true` locally to fail
closed when the independent scanner is unavailable; upstream publishing uses
this stricter mode. These local Git settings are not transferred to forks.

## Documentation

- [Forking and self-hosting](docs/FORKING.md)
- [Deployment contract](docs/DEPLOYMENT.md)
- [Security reporting](SECURITY.md)
- [Protocol specification](SHREDIT_PROJECT_SPEC.md)
- [Implementation decisions](docs/IMPLEMENTATION_DECISIONS.md)

Repository documentation is English. The application supports English and
Simplified Chinese; Russian documentation and UI copy must not be published.

The frozen specification includes historical deployment defaults; current
repository/branch/port settings are in the deployment guide. Do not publish
local operator rules, `_codex/`, environment files, keys, production logs, or
database backups. Each fork must supply its own origins, contacts, secrets,
trusted ingress, and capacity limits.

## License

[GNU AGPL v3 only](LICENSE). If you modify the application and make it available
to users over a network, provide those users access to the corresponding source
as required by the license. Preserve license and copyright notices.
