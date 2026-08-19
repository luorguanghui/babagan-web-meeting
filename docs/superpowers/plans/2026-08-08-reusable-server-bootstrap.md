# Reusable Server Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add non-interactive scripts that prepare a fresh Debian 12 server and its protected runtime configuration, then hand off to the existing guarded release script.

**Architecture:** `bootstrap-server.sh` owns host prerequisites and checkout convergence; `prepare-release.sh` owns protected local runtime configuration. Both emit only operator-checkable cloud evidence templates and invoke neither cloud provider APIs nor the release state machine. `deploy.sh` remains the only script that performs release creation, migration, health checks and smoke tests.

**Tech Stack:** Bash, Debian APT, Docker Engine/Compose, UFW, existing Docker Compose stack, existing API image, shell regression test harness.

## Global Constraints

- Accept only explicit non-interactive flags; never prompt for input.
- Support Debian 12 only and fail before mutation on any other operating system.
- Never write application secrets to stdout, command arguments, git-tracked files, or operator evidence templates.
- Use `set -Eeuo pipefail`, `umask 077`, fixed validated paths, and mode `600` for secret-bearing files.
- Do not automate Alibaba Cloud or Cloudflare account configuration; generate required evidence templates instead.
- Preserve the existing `deploy.sh` 1.1 GiB memory gate, full-SHA confirmation, release provenance, backup and rollback invariants.
- Do not change existing application APIs or production media behavior.

---

### Task 1: Add reusable host bootstrap script and executable regression coverage

**Files:**
- Create: `scripts/bootstrap-server.sh`
- Modify: `scripts/deployment-scripts.test.sh`
- Modify: `docs/04-deployment-and-operations.md`

**Interfaces:**
- Consumes: `--repo SSH_OR_HTTPS_GIT_URL`, `--branch BRANCH`, `--app-dir ABSOLUTE_PATH`, `--target-ip IPV4`, `--public-host HOST`, `--rtc-host HOST`, `--turn-host HOST`.
- Produces: a validated repository checkout, installed Docker/Compose/Git/curl/SQLite/UFW, converged host UFW rules, `/root/babagan-protected/cloud-requirements.txt` and `/root/babagan-protected/network.txt`.
- Does not call: `scripts/deploy.sh`, cloud-provider APIs, or secret generation.

- [ ] **Step 1: Write the failing executable regressions.**

Add temporary-root tests to `scripts/deployment-scripts.test.sh` that invoke the missing bootstrap path with mocked `apt-get`, `curl`, `git`, `ufw`, `systemctl`, `id`, `getent` and `docker` binaries. Cover:

```bash
if bash "$root/scripts/bootstrap-server.sh" --repo repo --branch main; then
  echo 'bootstrap accepted incomplete required flags' >&2; exit 1
fi

if bash "$root/scripts/bootstrap-server.sh" \
  --repo git@example.test:meeting.git --branch release --app-dir relative/path \
  --target-ip 203.0.113.10 --public-host meet.example.test \
  --rtc-host rtc.example.test --turn-host turn.example.test; then
  echo 'bootstrap accepted a relative application directory' >&2; exit 1
fi
```

Add a complete mocked run twice and assert UFW receives exactly TCP `22,80,443,7881` and UDP `443,50000:60000`, the protected evidence files have mode `600`, and the second run does not replace an unrelated checkout.

- [ ] **Step 2: Run the regression to verify RED.**

Run: `bash scripts/deployment-scripts.test.sh`

Expected: FAIL because `scripts/bootstrap-server.sh` does not exist.

- [ ] **Step 3: Implement `scripts/bootstrap-server.sh`.**

Implement a flag parser, Debian 12 detection, absolute-path validation that rejects `/`, `/root`, and paths outside `/opt`, and a checkout ownership marker such as `.git` with remote URL validation. Use idempotent commands:

```bash
apt-get update -qq
apt-get install -y -qq ca-certificates curl git sqlite3 ufw
ufw default deny incoming
ufw default allow outgoing
for rule in '22/tcp' '80/tcp' '443/tcp' '7881/tcp' '443/udp' '50000:60000/udp'; do
  ufw allow "$rule"
done
ufw --force enable
```

Install Docker only if missing, clone the requested repository only into an empty app directory, otherwise fetch the declared branch only when the existing `origin` URL matches `--repo`. Write protected operator evidence templates containing the exact content expected by `deploy.sh`; do not assert that cloud-side rules have been completed.

- [ ] **Step 4: Run the regression to verify GREEN.**

Run: `bash scripts/deployment-scripts.test.sh`

Expected: PASS, including the new bootstrap tests and all existing deployment provenance tests.

- [ ] **Step 5: Document invocation and cloud handoff.**

Add a concise reusable-server section to `docs/04-deployment-and-operations.md` with the exact command, required cloud-side rules, and the statement that generated evidence is a template requiring operator verification.

- [ ] **Step 6: Commit.**

```bash
git add scripts/bootstrap-server.sh scripts/deployment-scripts.test.sh docs/04-deployment-and-operations.md
git commit -m "feat: bootstrap reusable deployment hosts"
```

### Task 2: Add protected runtime preparation and regression coverage

**Files:**
- Create: `scripts/prepare-release.sh`
- Modify: `scripts/deployment-scripts.test.sh`
- Modify: `docs/04-deployment-and-operations.md`

**Interfaces:**
- Consumes: `--app-dir ABSOLUTE_PATH`, `--public-host HOST`, `--rtc-host HOST`, `--turn-host HOST`, `--admin-password-file FILE`, `--secret-dir ABSOLUTE_PATH`, optional `--rotate-secrets`.
- Produces: `infra/.env.production` mode `600`, `${secret-dir}/livekit-api-key`, `${secret-dir}/livekit-api-secret`, `${secret-dir}/cookie-secret`, `${secret-dir}/smoke-token`, all mode `600`.
- Requires: a locally built `babagan-meeting-api` image for Argon2id hash and LiveKit token generation.

- [ ] **Step 1: Write failing runtime-preparation regressions.**

Extend the shell harness with mocked `docker` that records environment-independent arguments and emits deterministic hash/token values. Test that a missing API image fails, that valid inputs create mode-600 outputs with derived URLs, and that rerunning without rotation refuses to overwrite a secret:

```bash
if bash "$root/scripts/prepare-release.sh" --app-dir "$app" \
  --public-host meet.example.test --rtc-host rtc.example.test --turn-host turn.example.test \
  --admin-password-file "$password" --secret-dir "$secrets"; then
  echo 'prepare-release overwrote existing protected secrets without rotation' >&2; exit 1
fi
```

Assert the captured stdout/stderr does not contain the password, deterministic LiveKit secret, cookie secret, password hash or token.

- [ ] **Step 2: Run the regression to verify RED.**

Run: `bash scripts/deployment-scripts.test.sh`

Expected: FAIL because `scripts/prepare-release.sh` does not exist.

- [ ] **Step 3: Implement `scripts/prepare-release.sh`.**

Validate hostnames using a conservative DNS-label expression and validate all paths before writes. Read the administrator password only from the supplied mode-600 file. Generate missing secrets with `openssl rand -hex 32`; use the API image with environment variables, not shell interpolation into node source, to derive Argon2id and a 300-second LiveKit token. Write the environment file atomically:

```bash
umask 077
env_tmp="$app_dir/infra/.env.production.$$.tmp"
cat >"$env_tmp" <<EOF
PUBLIC_BASE_URL=https://$public_host
LIVEKIT_URL=wss://$rtc_host
LIVEKIT_INTERNAL_URL=ws://livekit:7880
LIVEKIT_API_KEY=$livekit_key
LIVEKIT_API_SECRET=$livekit_secret
ADMIN_PASSWORD_HASH=$password_hash
COOKIE_SECRET=$cookie_secret
EOF
chmod 600 "$env_tmp"
mv "$env_tmp" "$app_dir/infra/.env.production"
```

Only permit replacing secret-bearing files when `--rotate-secrets` is present. On rotation, regenerate all mutually dependent LiveKit key/secret/token values together.

- [ ] **Step 4: Run the regression to verify GREEN.**

Run: `bash scripts/deployment-scripts.test.sh`

Expected: PASS with output redaction, file-mode, overwrite-refusal and URL derivation assertions.

- [ ] **Step 5: Document release handoff.**

Document the runtime-preparation command and the follow-up `deploy.sh --bootstrap-empty` invocation. Explicitly require the operator to replace the two cloud evidence templates only after verifying firewall, proxy modes and Full (strict).

- [ ] **Step 6: Commit.**

```bash
git add scripts/prepare-release.sh scripts/deployment-scripts.test.sh docs/04-deployment-and-operations.md
git commit -m "feat: prepare protected deployment runtime"
```

### Task 3: Integrate and verify the reusable workflow

**Files:**
- Modify: `docs/04-deployment-and-operations.md`
- Modify: `docs/acceptance/initial-release.md`

**Interfaces:**
- Consumes: outputs from `bootstrap-server.sh` and `prepare-release.sh` plus operator-verified evidence files.
- Produces: a documented command sequence terminating in the existing guarded `scripts/deploy.sh`.

- [ ] **Step 1: Write the failing workflow documentation regression.**

Add a static assertion to `scripts/deployment-scripts.test.sh` that the operations document names all three commands in order and states the 1.1 GiB memory gate:

```bash
grep -Fq 'bootstrap-server.sh' docs/04-deployment-and-operations.md
grep -Fq 'prepare-release.sh' docs/04-deployment-and-operations.md
grep -Fq 'deploy.sh --bootstrap-empty' docs/04-deployment-and-operations.md
grep -Fq '1.1 GiB' docs/04-deployment-and-operations.md
```

- [ ] **Step 2: Run the regression to verify RED.**

Run: `bash scripts/deployment-scripts.test.sh`

Expected: FAIL until the exact reusable workflow and memory gate are documented.

- [ ] **Step 3: Add the complete operator sequence.**

Document the noninteractive bootstrap command, protected password-file creation command, runtime preparation command, exact evidence-file location, explicit SHA acquisition with `git rev-parse HEAD`, and guarded first release command. Mark real cloud configuration and the first external smoke test as operator actions; do not mark them complete in the acceptance record.

- [ ] **Step 4: Run all relevant verification.**

Run:

```bash
bash scripts/deployment-scripts.test.sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Expected: all commands exit `0`; retain the existing non-failing Vite chunk-size warning only if present.

- [ ] **Step 5: Commit.**

```bash
git add docs/04-deployment-and-operations.md docs/acceptance/initial-release.md scripts/deployment-scripts.test.sh
git commit -m "docs: add reusable deployment workflow"
```

## Self-review

- Scope is limited to reproducible host/bootstrap preparation; it does not redesign deployment, media services, Cloudflare or Alibaba integrations.
- Every script behavior has an executable RED-to-GREEN shell test before implementation.
- Secret generation is local and file-based; cloud credentials and user passwords are never added to source control or command arguments.
- Existing release and rollback guards remain the final authority and are included in the complete verification matrix.
