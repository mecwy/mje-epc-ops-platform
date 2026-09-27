# MJE EPC operations platform

Phase 0 engineering baseline. Business workflows, real authentication and offline submission are not implemented. This is not an employee-ready or production-ready application.

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

Web: http://127.0.0.1:5178. API: http://127.0.0.1:3300/health/live. The worker boots and exits without processing jobs. Local dependency ports are 55433 (PostgreSQL) and 11001 (Azurite), bound to loopback. Example credentials are for these local emulators only.

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

The Azure workflow is manual and previews infrastructure only. No Azure identity or deployment has been verified here. Infrastructure examples are incomplete foundations; see [infra/bicep/README.md](infra/bicep/README.md). Do not provision production resources without explicit authorization.
