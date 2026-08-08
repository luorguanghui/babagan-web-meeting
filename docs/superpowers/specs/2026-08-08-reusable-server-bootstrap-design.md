# Reusable Server Bootstrap Design

**Goal:** provide a non-interactive, repeatable way to prepare a fresh Debian 12 server for this meeting application, without placing cloud-account credentials or existing secrets in source control.

## Scope

The existing deployment safeguards remain the release authority:

- `scripts/deploy.sh` validates a confirmed Git SHA, DNS, protected runtime files, capacity, ports, Compose configuration, release provenance, health checks, and HTTPS/WSS smoke tests.
- `scripts/rollback.sh`, `scripts/backup.sh`, and `scripts/restore.sh` remain unchanged and continue to own recovery.

The new bootstrap layer prepares a server for those scripts. It does not alter Cloudflare or Alibaba Cloud through account APIs.

## Components

### `scripts/bootstrap-server.sh`

Runs on a fresh Debian 12 server using explicit required flags:

```bash
sudo ./scripts/bootstrap-server.sh \
  --repo git@github.com:OWNER/REPOSITORY.git \
  --branch codex/web-meeting-implementation \
  --app-dir /opt/web-meeting \
  --target-ip 203.0.113.10 \
  --public-host meet.example.com \
  --rtc-host rtc.example.com \
  --turn-host turn.example.com
```

It verifies its flags, installs only the host dependencies required by the release scripts (Docker Engine with Compose, Git, curl, SQLite and UFW), configures a deny-by-default host firewall with the application ports, clones or updates the specified repository checkout, and writes no application secrets.

It must be safe to re-run: package installation, firewall rules, checkout update and Docker configuration converge to the declared values. It must reject a non-Debian-12 host, missing flags, unsafe app directory values, or an application directory owned by another checkout.

### `scripts/prepare-release.sh`

Runs after bootstrap using explicit host and secret-file inputs. It creates protected local secret files when they are absent, derives the Argon2id administrator-password hash through the built API image, creates a short-lived LiveKit smoke token, and writes `infra/.env.production` with mode `600`.

It accepts the public, RTC and TURN host names as arguments and derives the three public URLs. It never prints passwords, LiveKit secrets, cookie secrets, password hashes, or tokens. It refuses to overwrite any existing secret or production environment file unless an explicit `--rotate-secrets` flag is supplied.

### Cloud evidence template

Bootstrap writes an operator-facing checklist to the protected deployment directory. It states the exact Alibaba inbound rules and Cloudflare requirements that must be configured before calling `deploy.sh`:

- Alibaba: TCP `80,443,7881`; UDP `443,50000-60000`; restricted SSH.
- Cloudflare: public host proxied; RTC and TURN hosts DNS-only; SSL/TLS Full (strict).

The operator records completed checks in the existing evidence-file format consumed by `deploy.sh`. The scripts deliberately do not claim those cloud settings are complete without operator-provided evidence.

## Data flow

```text
explicit flags -> bootstrap-server.sh -> prepared Debian host + checkout + UFW
secret-file inputs -> prepare-release.sh -> protected .env + smoke token + evidence template
operator cloud configuration + evidence -> deploy.sh --bootstrap-empty -> migration + health + HTTPS/WSS smoke
```

## Error handling and security

- All scripts use `set -Eeuo pipefail`, argument validation, fixed paths, `umask 077`, and restrictive file modes.
- The scripts do not fetch a branch by name after confirmation; the existing deploy script still requires an explicit full Git SHA.
- No secret is embedded in an argument, log output, repository file, or generated documentation.
- The new scripts leave the 1.5 GiB deployment memory gate unchanged. A host below that threshold fails closed rather than silently reducing production safety requirements.

## Tests

Shell regression tests will execute bootstrap and preparation logic using temporary directories and mocked system commands. They will prove required-flag rejection, safe re-run behavior, host-firewall intent, no secret output, protected output modes, and refusal to overwrite secrets without rotation authorization.

## Self-review

- No cloud credentials or server-specific secrets appear in the design.
- Cloud-side configuration is intentionally separate from host-side bootstrap.
- The design reuses existing release, rollback, backup and smoke safeguards instead of duplicating them.
- The deployment memory safeguard remains mandatory.
