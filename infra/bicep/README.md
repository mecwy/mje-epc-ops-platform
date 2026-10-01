# 基础资源模板

main.bicep是Phase0草图，支持dev/uat/prod参数。只做静态编译，不代表云端ARM验证成功。Postgres管理员参数为secure，通过已经批准的bootstrap Key Vault引用注入；不能把密码写入example文件。新建vault尚无Private Endpoint不能供应用访问，必须在云连通性PR补齐；当前故意无业务app以免误暴露未鉴权基线。

每个环境独立VNet；当前地址段是设计占位，接企业网络前核IPAM避免重叠。HA只能在支持的SKU/区域启用，不得给Burstable启用。生产备份冗余、Blob ZRS/跨区策略和预算待批准；当前LRS和非地理备份不是容灾承诺。

未含RBAC授权、数据库Entra配置、KV私网端点、网络安全细化、应用容器/Jobs、预算告警和域名。部署前须在受控环境完成架构审查与云端PoC，不能直接视为生产模板。公开仓库不保存真实部署参数或内部审批资料。

## Dev owner Alpha candidate

`dev-subscription.bicep` scopes a new dedicated resource group and calls `dev-alpha.bicep`. Preview only against the explicitly verified non-production subscription. Do not rely on a CLI default subscription.

The candidate includes one Consumption Container Apps environment, a delegated VNet and PostgreSQL private DNS, PostgreSQL 17 B1ms/32GiB/7-day backup, one database, private versioned LRS evidence storage, ACR Basic, capped Log Analytics, and separate application/migration managed identities. No app ingress, running worker, production resources or budget notification is created by this template.

Authentication design is passwordless: the migration identity is the database Entra administrator; the application identity must subsequently be provisioned as a non-owner SQL role. Both can pull images; only the application identity receives Blob data access scoped to the evidence container. SQL privileges and tenant policies are a separate migration gate. Shared storage keys and public Blob access are disabled. Authenticated Azure endpoints remain network-accessible for Blob; containers are private.

No current component needs a long-lived application secret, so this Dev candidate does not create an unused Key Vault or private endpoint. If a secret-bearing integration is added, use a reviewed Key Vault path. Microsoft guidance: [PostgreSQL managed identity](https://learn.microsoft.com/en-us/azure/postgresql/security/security-connect-with-managed-identity), [Container Apps managed identity](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity).

Static Bicep compilation is not deployment verification. The manual GitHub workflow previews this Dev candidate only, through the `dev` environment and passwordless OIDC. Its identity needs read plus ARM what-if permission scoped to the Dev resource group; `ProviderNoRbac` intentionally does not claim deployment write access. The workflow neither creates resources nor tests the live database. Provider registration, quota/capacity, a successful ARM what-if, private SQL bootstrap/migration, actual token login, persistent writes and recovery remain separate online Alpha gates.

Rollback before deployment is code-only. After deployment, preserve database/storage and stop app traffic before reverting application revisions. Do not delete the resource group as an application rollback. Schema changes reach Dev only through the migration job; see the data-preserving rollback below.

## Dev owner application candidate

`dev-owner-app.bicep` is a separate, post-foundation Container App template. It requires an ACR image reference pinned by SHA-256 digest, an exact source revision, existing Dev registry/environment/application identity and the Entra tenant/API/SPA IDs. The API and browser share one origin. It allows public HTTPS ingress, but all business routes still require a verified delegated token and server-side membership. The app uses the application managed identity for image pull and the non-owner PostgreSQL login; Photo bytes go to the foundation's private `evidence` container through the same identity (`storageAccountName` parameter; the endpoint comes from that account). It has no connection string or long-lived key. Consumption scale is 0–1 replicas at 0.5 vCPU/1 GiB.

Deployment order is foundation → build and push the separate `Dockerfile.migrate` image by digest → create `dev-migration-job.bicep` → manually start it once to apply additive schema migrations as the migration identity → create a non-admin PostgreSQL Entra principal for the application identity on the `postgres` database → grant that principal membership in the migration-created `mje_alpha_app` role on `mje` → bootstrap a controlled owner/project membership → push an immutable application image and deploy this template. The migration job has no automatic schedule, no public ingress, one replica and no automatic retry. Its script requires the exact Dev server name pattern, database and migration identity and obtains a short-lived token at runtime. It must never use the local URL fallback. Done in Dev so far: the foundation, the migration image and job, the additive migrations, the application login and TEST project bootstrap, and the application image with this template (health check passes). Not yet done: online sign-in verification and a managed-identity Blob upload. Microsoft documents the [managed-identity PostgreSQL principal](https://learn.microsoft.com/en-us/azure/postgresql/security/security-connect-with-managed-identity) and [Container Apps registry identity](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity-image-pull).

Additional Dev sign-in accounts (OD05 path A, a B2B guest invited into the Dev directory, or path B, a member created there) are linked with `scripts/cloud-add-member.mjs`, once per person, after the bootstrap. The owner runs it as the bootstrap was run: one manual execution of the migration job with a command override (`node scripts/cloud-add-member.mjs`), keeping the job's `NODE_ENV`, `AZURE_CLIENT_ID`, `PGHOST` and `PGUSER` and adding `OWNER_TENANT_ID` (the Dev tenant, which must be the server's), `MEMBER_OBJECT_ID` (the account's object id in the Dev tenant), `MEMBER_ROLE` (`PROJECT_MANAGER` or `EXECUTIVE_READER`), `MEMBER_DISPLAY_NAME` (a `TEST ` label, never a real name) and `PROJECT_CODE=TEST-R11`. In one transaction it creates or reuses the TEST Person, LoginAccount and project membership, refuses the owner's object id, another person's account, a different existing role and any inactive row, and ends with the API's readiness check. Overlapping runs for the same account are serialised. The script's only identity key is the object id: it cannot tell that two object ids are the same natural person, and a display name is never an identity key. The owner must not run it for anyone already onboarded under another object id, including someone moving from path A to path B; linking a second account to an existing Person is a separate, reviewed change.

The browser SPA redirect URI must then match the actual HTTPS Container App URL. Verify the exact Dev app registration before owner login. A successful local or public CI build does not establish cloud database reachability, capacity, token consent or a usable app. The Dev foundation and app can incur charges after deployment; obtain the cost decision before creating them. Reverting an app revision should preserve database snapshots and Blob evidence.

## Rollback that preserves data (Dev and later)

Once an environment holds records that must be kept, an application rollback never removes schema or data:

1. **Block writes first, and keep them blocked.** Scaling to zero is not a block: this app scales 0–1 on HTTP, so a request starts a replica again, and in `Single` revision mode a newly deployed revision receives traffic at once. Restrict the app's ingress at the app level so it survives revision changes, for example an IP security restriction that allows only the owner's current address, or disable ingress. Then confirm existing writers have stopped: no active replica of the old revision, and the newest `AuditLog` row stays unchanged.
2. **Choose a rollback digest only if it is compatible with the retained schema and data.** Additive migrations do not prove this: later migrations can add enum values, constraints, grants, row-level-security policies and rows the older code never saw. Check the older code against the current migration history and representative current rows. If it is not compatible, keep writes blocked and fix forward instead.
3. **Deploy the chosen digest while writes are still blocked.** Keep the migration history, every added table and column, grants, row-level-security policies, immutability triggers, every `Revision`, `RevisionEvent` and `AuditLog` row, and every Blob object. Fix forward with a new, reviewed migration if the schema itself must change.
4. **Verify before reopening.** If ingress was disabled, re-enable it with only the owner's address allowed; keep general access blocked until the checks pass. Through the owner's allowed address, check sign-in, representative reads and writes, and that an unauthorised account is still refused. Then remove the restriction explicitly.

Database-destructive operations (`DROP TABLE` / `DROP COLUMN`, `prisma db push` / `migrate reset`) are allowed only on a database explicitly labelled as a disposable TEST database. A disposable TEST database does not make its resource group disposable: the Dev group also holds PostgreSQL and evidence storage, and Blob versioning does not survive deleting the storage account. Deleting a resource group is never part of an application rollback; a separate teardown first establishes that the whole group and every resource in it are disposable. This supersedes the "drop the four tables and the `correctionReason` column" note in the A2 pull request, which was written before Dev held any data.

## Selfie retention sweep and blob backstop (Dev)

Selfies are kept `SELFIE_RETENTION_DAYS` after they were attached, then deleted with an audit row
(A6 design §3, U9). The sweep is `node dist/cleanup-selfies.js` in the app image, run by the
scheduled job `mjeepc-dev-selfie-cleanup` under the app identity (PM decision 2026-10-01, option A:
no new role). A storage lifecycle rule deletes any blob under `evidence/selfie/` older than
`SELFIE_BLOB_BACKSTOP_DAYS` (design C25: the few an interrupted upload left without a row). The
numbers live once, in `@mje/domain` (`packages/domain/src/checkin-store.ts`); the templates take them
as parameters and the job refuses to run with a different value. Deleted selfies cannot be restored:
that is the retention, not a rollback item.

Values from the code (after `pnpm build`):

```bash
RET=$(node -e "import('./packages/domain/dist/index.js').then(m=>console.log(m.SELFIE_RETENTION_DAYS))")
GRACE=$(node -e "import('./packages/domain/dist/index.js').then(m=>console.log(m.SELFIE_GRACE_MINUTES))")
BACKSTOP=$(node -e "import('./packages/domain/dist/index.js').then(m=>console.log(m.SELFIE_BLOB_BACKSTOP_DAYS))")
```

1. **Job, dry run first** (counts only, deletes nothing). `cleanupOrgIds` is the comma-separated list of
   organization ids to sweep (the app login cannot list organizations). Use the app image digest that is
   deployed.
   ```bash
   az deployment group create -g mjeepc-dev -f infra/bicep/dev-selfie-cleanup-job.bicep \
     -p registryName=<acr> postgresFqdn=<fqdn> storageAccountName=<account> \
        imageReference=<acr>.azurecr.io/mje-app@<digest> cleanupOrgIds=<org-id> \
        selfieRetentionDays=$RET selfieGraceMinutes=$GRACE dryRun=true
   az containerapp job start -n mjeepc-dev-selfie-cleanup -g mjeepc-dev
   az containerapp job execution list -n mjeepc-dev-selfie-cleanup -g mjeepc-dev -o table
   ```
   The log lines are `{"event":"selfie_cleanup","orgId":…,"dryRun":true,"eligible":N,…}` (Log Analytics,
   `ContainerAppConsoleLogs_CL` filtered on the job name). Exit 2 = configuration refused (nothing swept);
   exit 1 = a delete failed (the next run finishes the DELETING rows).
2. **Job, live**: redeploy with `dryRun=false`; the schedule (every 6 hours, UTC) then runs it.
3. **Lifecycle backstop**:
   ```bash
   az deployment group create -g mjeepc-dev -f infra/bicep/dev-selfie-lifecycle.bicep \
     -p storageAccountName=<account> selfieBackstopDays=$BACKSTOP
   ```
4. **Rollback**: `az containerapp job delete -n mjeepc-dev-selfie-cleanup -g mjeepc-dev` stops the sweep;
   `az storage account management-policy delete --account-name <account> -g mjeepc-dev` removes the backstop.
   Rows already DELETED keep their audit entries; blobs already deleted are gone by design.

A separate worker identity with its own blob role and database login (the full environment's
`main.bicep`) is not part of the Dev setup.
