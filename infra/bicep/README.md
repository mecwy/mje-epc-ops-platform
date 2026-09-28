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
