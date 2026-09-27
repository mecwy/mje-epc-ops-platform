// Dev-only, passwordless foundation. No application ingress until the authenticated image is ready.
targetScope = 'resourceGroup'
param location string = 'francecentral'
@minLength(3)
@maxLength(12)
param prefix string = 'mjeepc'
var suffix = uniqueString(resourceGroup().id)
var tags = { project: 'mje-epc', environment: 'dev', purpose: 'owner-alpha' }

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-dev-app'
  location: location
  tags: tags
}
resource migrationIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-dev-migration'
  location: location
  tags: tags
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${prefix}dev${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}
resource pullApp 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, appIdentity.id, 'AcrPull')
  scope: registry
  properties: {
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}
resource pullMigration 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, migrationIdentity.id, 'AcrPull')
  scope: registry
  properties: {
    principalId: migrationIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-dev-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json('0.1') }
  }
}
resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${prefix}-dev-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.72.0.0/16'] }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: '10.72.0.0/23'
          delegations: [{ name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'database'
        properties: {
          addressPrefix: '10.72.2.0/24'
          delegations: [{ name: 'pg', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
          serviceEndpoints: [{ service: 'Microsoft.Storage' }]
        }
      }
    ]
  }
}
resource dns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: '${prefix}-dev.postgres.database.azure.com'
  location: 'global'
}
resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dns
  name: 'database-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-dev-pg-${suffix}'
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '17'
    authConfig: { activeDirectoryAuth: 'Enabled', passwordAuth: 'Disabled', tenantId: tenant().tenantId }
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: {
      delegatedSubnetResourceId: '${vnet.id}/subnets/database'
      privateDnsZoneArmResourceId: dns.id
      publicNetworkAccess: 'Disabled'
    }
  }
  dependsOn: [dnsLink]
}
// Only this separate identity can bootstrap/migrate. The web app receives a non-owner SQL role later.
module migrationAdmin 'dev-database-admin.bicep' = {
  name: 'dev-database-admin'
  params: {
    serverName: postgres.name
    principalId: migrationIdentity.properties.principalId
    principalName: migrationIdentity.name
  }
}
resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: { value: 'BTREE_GIST', source: 'user-override' }
}
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'mje'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('${prefix}dev${suffix}', 24)
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Enabled'
  }
}
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
  }
}
resource evidence 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'evidence'
  properties: { publicAccess: 'None' }
}
resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(evidence.id, appIdentity.id, 'BlobContributor')
  scope: evidence
  properties: {
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-dev-aca'
  location: location
  tags: tags
  properties: {
    vnetConfiguration: { infrastructureSubnetId: '${vnet.id}/subnets/apps', internal: false }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}
output appIdentityId string = appIdentity.id
output appClientId string = appIdentity.properties.clientId
output appPrincipalId string = appIdentity.properties.principalId
output migrationIdentityId string = migrationIdentity.id
output migrationClientId string = migrationIdentity.properties.clientId
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output registryServer string = registry.properties.loginServer
output storageEndpoint string = storage.properties.primaryEndpoints.blob
output environmentId string = environment.id
