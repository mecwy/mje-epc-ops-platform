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

Rollback before deployment is code-only. After deployment, preserve database/storage and stop app traffic before reverting application revisions. Do not delete the resource group as an application rollback. This candidate has no database schema changes.

## Dev owner application candidate

`dev-owner-app.bicep` is a separate, post-foundation Container App template. It requires an ACR image reference pinned by SHA-256 digest, an exact source revision, existing Dev registry/environment/application identity and the Entra tenant/API/SPA IDs. The API and browser share one origin. It allows public HTTPS ingress, but all business routes still require a verified delegated token and server-side membership. The app uses the application managed identity for image pull and the non-owner PostgreSQL login; it has no connection string or long-lived key. Consumption scale is 0–1 replicas at 0.5 vCPU/1 GiB.

Deployment order is foundation → provision a separate database migration image/job → apply additive schema migrations as the migration identity → create a non-admin PostgreSQL Entra principal for the application identity on the `postgres` database → grant that principal membership in the migration-created `mje_alpha_app` role on `mje` → bootstrap a controlled owner/project membership → push an immutable image and deploy this template. None of those cloud steps has been run. Microsoft documents the [managed-identity PostgreSQL principal](https://learn.microsoft.com/en-us/azure/postgresql/security/security-connect-with-managed-identity) and [Container Apps registry identity](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity-image-pull).

The browser SPA redirect URI must then match the actual HTTPS Container App URL. Verify the exact Dev app registration before owner login. A successful local or public CI build does not establish cloud database reachability, capacity, token consent or a usable app. The Dev foundation and app can incur charges after deployment; obtain the cost decision before creating them. Reverting an app revision should preserve database snapshots and Blob evidence.
