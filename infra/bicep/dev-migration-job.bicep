// Create only after the approved Dev foundation exists. Running the job is a separate controlled step.
targetScope = 'resourceGroup'
param location string = resourceGroup().location
param environmentName string = 'mjeepc-dev-aca'
param registryName string
param migrationIdentityName string = 'mjeepc-dev-migration'
param postgresFqdn string
@description('Migration ACR image pinned by sha256 digest')
param imageReference string

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: environmentName }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: migrationIdentityName }

resource migration 'Microsoft.App/jobs@2024-03-01' = {
  name: 'mjeepc-dev-migrate'
  location: location
  tags: { project: 'mje-epc', environment: 'dev', purpose: 'schema-migration' }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      replicaRetryLimit: 0
      replicaTimeout: 1800
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
    }
    template: {
      containers: [{
        name: 'migration'
        image: imageReference
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
          { name: 'PGHOST', value: postgresFqdn }
          { name: 'PGDATABASE', value: 'mje' }
          { name: 'PGUSER', value: identity.name }
        ]
      }]
    }
  }
}

output jobName string = migration.name
