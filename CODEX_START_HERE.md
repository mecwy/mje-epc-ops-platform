# Start here

Read README.md and AGENTS.md. This is the public code checkout with fresh history and synthetic tests only. Obtain the current task, candidate commit and permitted files from the PM-maintained handover in the separately controlled archive. Historical phase descriptions are not the current delivery schedule. Do not infer permission to implement full CRM or payments.

Before business implementation, verify the approved requirements and open decisions in the separately controlled local archive. Do not copy those documents into this checkout. GitHub CI validates the tested public candidate. Azure identity, Entra sign-in, cloud connectivity and backup/restore require separate evidence tied to the relevant environment and version.

Codex implements assigned changes; the assigned independent Claude reviewer reviews the pinned candidate. Use [the review request](.github/independent-review-template.md) within that existing review. PM distributes common governance requirements and assigns implementation scope; governance findings do not independently assign work to writers.

Run pnpm check and pnpm format:check before committing. Run migrations and integration checks for database changes. New tracked files require public-files.json review. Never merge private Git history, publish real fixtures, or claim synthetic checks satisfy source-document or business acceptance.
