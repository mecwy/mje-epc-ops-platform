# Independent review request

The writer fills the input section before submitting this request through the existing independent review runner. Pin the candidate commit; changing code after review requires the existing re-review policy. Do not publish controlled requirements, source documents, review logs or personal data with this template.

## Input

- Task / requirement references:
- BASE commit / HEAD commit / repository:
- Final behavior and affected files:
- Module owners, permitted exits and sole writer of each affected fact:
- Contract / migration / compatibility changes:
- Executed checks and results; untested paths:
- Applicable invariant references and negative scenarios:
- Existing debt touched by this change; proposed disposition:

## Review

Perform the existing correctness, authorization, concurrency, regression and requirement review. In the same report, also answer the following. For each item record PASS, FINDING or NOT APPLICABLE with a short evidence reference and scope; do not treat a checkbox as evidence.

| ID  | Check                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------- |
| M1  | Does the change duplicate a business rule that already has an owner?                                                    |
| M2  | Does it create a second writable source of truth? Distinguish immutable snapshots and read models from competing facts. |
| M3  | Does it cross a module boundary, bypass an approved exit or write another module's tables?                              |
| M4  | Are authorization, versions and business invariants enforced on the server rather than only in the UI?                  |
| M5  | Does it silently change an existing contract, schema, historical interpretation or retry behavior?                      |
| M6  | Is the change larger or more abstract than the current requirement needs?                                               |

Findings must identify the affected path, trigger, consequence, evidence and proportionate remedy. Classify by demonstrated consequence. Distinguish a defect requiring correction from nonblocking debt; debt needs an owner, trigger for repayment and closure criterion. Keep the independent approve/reject conclusion separate from the maintenance summary (PASS / PASS WITH DEBT / BLOCK). Maintenance PASS does not replace independent approval, CI or acceptance.

Do not automatically introduce new review rounds, reject an already valid report because this template is newer, or expand review to unrelated legacy modules. Future features without an implementation must be marked unverified, not PASS.
