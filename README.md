# MJE EPC operations platform

**Current state (see AGENTS.md for the maintained summary):** Site Daily Close rules and contracts, the daily-report database and API, issues and escalation, the web report and issue screens, the photo backend (storage, API, snapshot links) and a guarded Dev bootstrap job are merged. Every figure is a declaration, not a verification. The photo screens, field check-in / foreman quantities, the executive multi-project home and offline queueing are not implemented. Real Entra sign-in, real phones and cloud persistence have not been verified. This is not an employee-ready or production-ready application.

The selected stack is TypeScript strict, React/Vite, NestJS, a Node worker, PostgreSQL/Prisma and Azure Blob, with Azure Container Apps as the intended application runtime. The first business scope is Site Daily Close. CRM, costing and payments currently have schema placeholders only.

## Local development

Install Node **24.21.0**, pnpm **10.34.5** and Docker Compose v2.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d --wait postgres azurite
pnpm db:migrate
pnpm dev
```

Web: http://localhost:5178. API: http://127.0.0.1:3300/health/live. The worker boots and exits without processing jobs. Local dependency ports are 55433 (PostgreSQL) and 11001 (Azurite), bound to loopback. Example credentials are for these local emulators only.

```sh
pnpm check
pnpm format:check
pnpm test:smoke
pnpm test:integration
docker compose down
```

Stopping Compose retains data volumes. Do not run destructive database commands against shared or production environments.

## Code and data separation

This public repository starts with fresh Git history. It contains code, schema, infrastructure examples and synthetic TEST inputs. Internal requirements, original site reports, photos, contracts, conversation exports and private Git history are excluded. Do not merge history from a private source repository into this repository.

Keep private development evidence in a separate controlled local location with a private backup. In a deployed system, business records belong in an authenticated database and photos/files in private Blob storage. Public source code does not make application data public. Azure credentials must use managed identity/OIDC and Key Vault; local `.env` files must remain untracked.

`public-files.json` is the reviewed file allowlist. Review new files before registering them. `pnpm check:public` checks the Git index for unexpected files, prohibited data paths, symlinks, binaries and recognizable credential patterns. It is a guard against mistakes, not a guarantee that code contains no confidential text. Review staged diffs before every push; a CI failure happens after upload and cannot undo disclosure.

## Verification limits

Public CI checks formatting, types, build, publication guards, process startup, database constraints and private Blob access using synthetic data. It does not read private source documents or execute real-source acceptance. Source hash/table-coordinate regression remains in the controlled local archive. Passing this CI is not evidence of field verification, business acceptance or production readiness.

The Azure workflow is manual and previews infrastructure only. The Dev foundation and database migrations are applied by the owner's controlled CLI, not by CI; the Dev application login and TEST project were bootstrapped and the application was deployed the same way (health check passes); a real Microsoft sign-in has not been verified yet. Infrastructure examples are incomplete foundations; see [infra/bicep/README.md](infra/bicep/README.md). Do not provision production resources without explicit authorization.

## Owner Alpha preparation

The S0 slice adds a non-root, same-origin Web/API image, source revision in health, and a tested Entra v2 delegated-token verifier. The later manual-declaration API slice below wires server membership and saved versions. The browser UI uses MSAL with the server-provided Dev configuration; it cannot save without a real login and project membership. The complete browser login and cloud persistence path remain unverified.

Run `pnpm test:container` with Docker available to build and probe the packaged image. It checks the page, source identity, security headers, private path denial and runtime UID. It creates and removes only its uniquely named TEST container/image.

`infra/bicep/dev-subscription.bicep` is a separate Dev-only passwordless foundation preview. It leaves the historical foundation template unchanged. See the infrastructure README for resource, identity and validation limits.

## Manual declaration API (local verification)

The Alpha API slice implements server-authorized project listing, draft saves, immutable saved versions, correction ancestry and record/history reads. All records remain manual declarations, with pending assignment and review; no actual labor hours, acceptance or approval is generated. Photo source metadata can be declared, but photo upload and independent review endpoints are not enabled. The browser follows the source-shaped daily-report sections: progress, workforce, machinery, material, milestones, narratives and photo references. It keeps an ambiguous save request for same-key retry and never shows a simulated login as a real session.

`ALPHA_ENABLED=true` requires exact Entra tenant, API audience and SPA client configuration. Every request verifies its token, then resolves an active account/person and project-specific `ALPHA_OWNER` membership. Client-supplied organization, role or actor fields are rejected. The deployed process requires a managed identity database connection and rejects owner/superuser/RLS-bypass roles. `ALPHA_DATABASE_URL` is for local development only, with a separately provisioned non-owner login. No sample or fallback login exists.

Writes use a stable record UUID, `Idempotency-Key` matching `clientMutationId`, `expectedVersion`, and explicit `baseRevisionNumber` (null for the first saved version). A saved-version correction needs a reason. The transaction atomically updates the draft, appends the immutable revision/audit when applicable, and records the replay response. Replay rechecks authorization first. Draft updates after an immutable version are labeled draft; the saved version remains readable. Project/business-date changes to an existing record are refused; record a separate declaration instead.

The additive migration creates `AlphaDraft` referencing existing `DailyClose`; it reuses `Revision`, `RevisionEvent`, `AuditLog` and `IdempotencyRecord`. Existing immutable-source migrations are unchanged. The non-login group `mje_alpha_app` has only required table privileges and tenant policies. The migration owner retains recovery privileges and must never be the application identity. Assignment of a cloud managed identity to the SQL role and initial owner/project membership is still a controlled bootstrap step. Database commands use parameterized SQL for transaction/locking behavior; Prisma owns the schema and migration history.

Run `pnpm build`, `pnpm db:migrate`, `pnpm test:integration` and `pnpm test:alpha` with local Compose available. The Alpha runner refuses non-local hosts, creates uniquely named TEST databases/login, exercises HTTP and RLS, dumps/restores to a second isolated database, and removes only those test resources. It requires Docker Compose for matching-version PostgreSQL backup tools. In CI it runs against synthetic local services only.

Rollback: disable Alpha or redeploy the preceding image while retaining all added tables, versions and audits. Never reverse/drop the applied migration to roll back an app. Cloud persistence, real Entra/browser login, Blob recovery and owner UAT are still NOT RUN; passing these local checks is not online readiness or full AT/LR acceptance.
