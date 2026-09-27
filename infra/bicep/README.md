# 基础资源模板

main.bicep是Phase0草图，支持dev/uat/prod参数。只做静态编译，不代表云端ARM验证成功。Postgres管理员参数为secure，通过已经批准的bootstrap Key Vault引用注入；不能把密码写入example文件。新建vault尚无Private Endpoint不能供应用访问，必须在云连通性PR补齐；当前故意无业务app以免误暴露未鉴权基线。

每个环境独立VNet；当前地址段是设计占位，接企业网络前核IPAM避免重叠。HA只能在支持的SKU/区域启用，不得给Burstable启用。生产备份冗余、Blob ZRS/跨区策略和预算待批准；当前LRS和非地理备份不是容灾承诺。

未含RBAC授权、数据库Entra配置、KV私网端点、网络安全细化、应用容器/Jobs、预算告警和域名。部署前须在受控环境完成架构审查与云端PoC，不能直接视为生产模板。公开仓库不保存真实部署参数或内部审批资料。
