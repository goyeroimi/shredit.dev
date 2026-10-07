# Deployment Notes

These notes package the frozen Shredit deployment contract. They do not authorize a production deploy and do not contain production credentials.

## Local Services

Use only local PostgreSQL and Valkey. Never point local commands at a production `DATABASE_URL`.

```powershell
Copy-Item .env.example .env.local
docker compose -f docker-compose.local.yml up -d postgres valkey
pnpm install --frozen-lockfile
pnpm run db:migrate
pnpm run db:reconcile-capacity
pnpm run cleanup:expired
pnpm run dev
```

Host-side maintenance commands load `.env.local` when it exists. In containers the file is not
required: Compose or Dokploy injects the environment directly.

To verify the production-shaped standalone server on the host, build before starting it:

```powershell
pnpm run build
pnpm start
```

The build copies `.next/static` and `public` into `.next/standalone`, so `pnpm start` serves the
complete standalone package rather than an asset-less Next.js server.

For a containerized local production-shaped run:

```powershell
docker compose -f docker-compose.local.yml up -d --build
```

The full Compose startup waits for healthy PostgreSQL and a started Valkey service, runs the
one-shot `migrate` service (`db:migrate` followed by `db:reconcile-capacity`), and starts `app` only
after that service exits successfully. Valkey health does not gate application startup because
readiness deliberately supports a degraded Valkey state. The application image is built from the
`runner` target. To run the optional one-shot cleanup service manually:

```powershell
docker compose -f docker-compose.local.yml --profile maintenance run --rm cleanup
```

Check the process without consuming any note:

```powershell
Invoke-WebRequest http://127.0.0.1:3232/health/live
Invoke-WebRequest http://127.0.0.1:3232/health/ready
```

The compose file provisions disposable local volumes named `shredit-postgres-data` and `shredit-valkey-data`. Do not reuse those values for production. Stop local services with `docker compose -f docker-compose.local.yml down`; remove local volumes only when the test data is intentionally disposable.

## Dokploy Topology

```text
Dokploy application: Next.js standalone container
Dokploy service:     Valkey
External service:    PostgreSQL via DATABASE_URL
Optional service:    Tor hidden service with persistent key volume
```

The deployment path is:

```text
approved push to master -> Dokploy pulls Git -> Docker build -> release migrations/reconciliation -> restart -> health/readiness routing
```

Target repository: `git@github.com:goyeroimi/shredit.dev.git`; target branch: `master`. Public source and commit links use `https://github.com/goyeroimi/shredit.dev` without the `.git` suffix. Fork operators must use their own repository, origin, contacts, and build revision.

This is the intended repository contract, not evidence that an existing Dokploy application has been migrated. Provider configuration and a production deployment require separate operator approval. A push to a provider-connected branch may deploy immediately.

Keep `PUBLIC_REPOSITORY_LINKS_ENABLED=false` until the intended public repository contains the exact deployed commit and all Git-hosted security/abuse contacts have been updated to the intended public identity. Then set the flag to `true` to restore source and commit links without a code change. A commit link identifies the declared source revision; it is not a cryptographic verification of the JavaScript served by an operator.

Configure the Dokploy application to build the repository with `Dockerfile` target `runner`, inject the exact commit as `NEXT_PUBLIC_GIT_COMMIT`, and expose port `3232`. Keep the Docker runtime command `node --require ./scripts/inject-peer-address.cjs server.js`; the preload preserves the actual socket peer for legacy/local trust and diagnostics, while production surface trust uses the ingress token described below. If Dokploy invokes the package `start` script instead, `scripts/start-standalone.cjs` pins the same `3232`/`0.0.0.0` bind while the package command retains the required preload.

## Release Commands

Build the same commit with Dockerfile target `maintenance` and run this command once as a Dokploy
release job before traffic is switched:

```text
pnpm run db:migrate && pnpm run db:reconcile-capacity
```

Use the same `maintenance` target for a separate scheduled job every five minutes:

```text
pnpm run cleanup:expired
```

Never run release or maintenance commands as a per-replica startup command. Migrations and capacity
reconciliation are one release job, and cleanup is one independently scheduled job. Ensure only one
cleanup worker runs at a time. Cleanup removes expired notes and eligible idempotency tombstones in
bounded batches. It must not silently remove unexpired notes to correct a capacity mismatch.
PostgreSQL backup and retention policy remain operator-owned; the application does not provision or
manage backups.

## Health And Proxy Contract

- `/health/live` is process liveness only and must not touch PostgreSQL or Valkey.
- `/health/ready` checks PostgreSQL, migration state, required configuration, and capacity. It returns `200` with `valkey: "ok"` or `valkey: "degraded"`; database/migration failure returns `503`.
- Configure the container health check against `/health/live` and route readiness against `/health/ready`.
- Apply cache bypass for `/n/*`, `/api/*`, and `/health/*`. All HTML, API, metadata, health, and error responses are `Cache-Control: no-store`.
- Reverse-proxy access logs must redact query strings, fragments, request bodies, note-route IDs, and `Idempotency-Key`. Application logger redaction alone is insufficient.
- Keep the application port private to the reverse proxy. Generate one random 32-byte value encoded as unpadded base64url (43 characters) and provide it to the application through a server-only `INGRESS_AUTH_TOKEN` or a mounted secret file referenced by `INGRESS_AUTH_TOKEN_FILE`. The same value must reach Traefik through a secret mount or secret-manager-rendered dynamic configuration. Never place it directly in Docker labels, repository files, shell history, logs, or reports. Configure exactly one application token source.
- On every public router, Traefik must discard any inbound `X-Shredit-Ingress-Auth` and `X-Shredit-Surface`, then stamp its own `X-Shredit-Ingress-Auth` value and set `X-Shredit-Surface` to exactly `clearnet` or `onion` after vhost selection. A custom request-header assignment must overwrite rather than append. If the configured token is missing or wrong, the application rejects the surface even when the socket peer matches a legacy CIDR; CIDR fallback cannot bypass a configured token.
- `TRUSTED_PROXY_CIDRS` identifies trusted upstream forwarding hops used to canonicalize `X-Forwarded-For` and country, plus legacy/local final peers when no token is configured. For Cloudflare use the complete published IPv4 and IPv6 CIDR sets, not current DNS answers for `shredit.dev`, individual edge addresses, or an ephemeral Docker container `/32`. Keep Traefik `forwardedHeaders.trustedIPs` aligned with those upstream ranges and never enable `forwardedHeaders.insecure`.
- The application accepts a forwarded client IP/country in token mode only when the canonical `X-Forwarded-For` chain contains at least one configured trusted upstream hop to the right of the client. Requests that lack that evidence use the fail-safe `unknown-ip`/unknown-country behavior, so they cannot obtain the CN Turnstile bypass from spoofed `CF-*` headers. Test direct-origin and duplicate-header spoof attempts before enabling the bypass.
- Prefer Cloudflare Tunnel or an origin firewall restricted to Cloudflare's published ranges so clients cannot bypass Cloudflare. This is additional origin protection; it does not replace the Traefik-to-application ingress token.
- Clearnet uses HSTS and the Turnstile origins only when Turnstile is enabled. Onion responses omit HSTS enforcement, Cloudflare sources, `upgrade-insecure-requests`, and all third-party assets.

## Required Runtime Configuration

The complete variable template is in [`.env.example`](../.env.example). Non-loopback production must provide at least `DATABASE_URL`, `VALKEY_URL`, `PUBLIC_BASE_URL`, `GIT_REPOSITORY_URL`, `NEXT_PUBLIC_GIT_COMMIT`, `SECURITY_CONTACT`, `SECURITY_POLICY_URL`, `ABUSE_CONTACT`, `ABUSE_POLICY_URL`, one of `INGRESS_AUTH_TOKEN` or `INGRESS_AUTH_TOKEN_FILE`, `TRUSTED_PROXY_CIDRS`, `IDEMPOTENCY_HMAC_SECRET`, `IP_HASH_SECRET`, `POW_SECRET`, and finite `MAX_ACTIVE_NOTE_BYTES`/`MAX_ACTIVE_NOTE_COUNT`. The resolved ingress token must be an independently generated canonical 32-byte unpadded base64url value. `ONION_URL` and Turnstile credentials are optional only when those features are disabled.

All secrets remain server-only. `NEXT_PUBLIC_GIT_COMMIT` is public build metadata. `PUBLIC_REPOSITORY_LINKS_ENABLED` defaults to `false`; enable it only after `GIT_REPOSITORY_URL` points at the intended public account. Local secrets take precedence over global shell values, and production values must be injected by Dokploy rather than committed.

## Git And SSH

Use a separate Ed25519 deploy key for each repository and role. Do not reuse an upstream operator's key or a personal/default SSH identity. Keep local project keys in an ignored, access-restricted directory, for example:

```text
/_codex/ssh/github-deploy/id_ed25519
/_codex/ssh/github-deploy/id_ed25519.pub
/_codex/ssh/github-deploy/config
/_codex/ssh/github-deploy/known_hosts
```

Pin the project-local SSH configuration through local Git `core.sshCommand`: set `IdentityFile`, `IdentitiesOnly=yes`, `IdentityAgent=none`, `StrictHostKeyChecking=yes`, and dedicated GitHub `known_hosts` obtained from a trusted HTTPS source. Disable password/interactive fallback. If a project requires an outbound proxy, configure the actual SSH CONNECT/SOCKS route; HTTP proxy variables alone do not route SSH. Do not change global Git/SSH identity settings.

Add only the `.pub` contents in the repository's **Settings -> Deploy keys**. Enable write access only for a key that needs to push; a provider's clone key should remain read-only and separate. Never publish the private key. `/_codex/`, all `project_rules.md` files, environment secrets, database dumps, and generated evidence must stay outside Git and Docker/deployment artifacts. A fork must generate independent runtime secrets; the example values are disposable local fixtures.

## Rollback And Incident Handling

Do not run production rollback, database access, root access, or Dokploy webhooks without separate explicit authorization. For an application-only incident, preserve the exact deployed commit, stop new traffic through the operator's normal Dokploy mechanism, and use the approved migration/rollback procedure. Do not restore note data from backups as an application feature; consumed-note recovery is outside the product contract.

## Launch Checklist

Before public traffic, the owner must set production capacity, provision the ingress token through an approved secret path, verify trusted upstream proxy/GeoIP behavior, provision the optional onion origin, complete native EN/zh-CN copy review, complete final legal pages, and review the Shredit/Shred-it naming risk. These are launch checks, not reasons to add scope or weaken security invariants.
