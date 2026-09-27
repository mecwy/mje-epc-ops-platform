# Start here

Read README.md and AGENTS.md. This is the public code checkout with fresh history and synthetic tests only. Preserve Phase 0 boundaries. Next planned scope is identity, authorization and project/person master data; do not implement full CRM or payments without an explicit request.

Before business implementation, verify the approved requirements and open decisions in the separately controlled local archive. Do not copy those documents into this checkout. GitHub CI validates this public baseline; Azure OIDC, Entra login, cloud connectivity and backup/restore PoCs remain unverified.

Run pnpm check and pnpm format:check before committing. Run migrations and integration checks for database changes. New tracked files require public-files.json review. Never merge private Git history, publish real fixtures, or claim synthetic checks satisfy source-document or business acceptance.
