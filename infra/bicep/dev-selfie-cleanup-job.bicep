// Dev selfie retention sweep (design §3, U9): a scheduled Container Apps job that runs the app
// image's cleanup entry (`node dist/cleanup-selfies.js`) under the app identity, which already
// holds Storage Blob Data Contributor on the evidence container (PM decision 2026-10-01, option A:
// no new role; a separate worker identity is the full environment's, main.bicep). Deploying and
// starting the job are separate Owner steps (README). Keep `dryRun` true for the first run.
targetScope = 'resourceGroup'
param location string = resourceGroup().location
param environmentName string = 'mjeepc-dev-aca'
param registryName string
param appIdentityName string = 'mjeepc-dev-app'
param postgresFqdn string
param storageAccountName string
@description('App ACR image pinned by sha256 digest: the same image as the app')
param imageReference string
@description('Cron in UTC; every 6 hours by PM decision')
param cronExpression string = '0 */6 * * *'
@description('Count only, delete nothing. The first Dev run keeps this true.')
param dryRun bool = true
@description('SELFIE_RETENTION_DAYS from @mje/domain (the single source); the job refuses a different value')
param selfieRetentionDays int
@description('SELFIE_GRACE_MINUTES from @mje/domain (same check)')
param selfieGraceMinutes int
@description('Rows claimed per organization per run')
param batchLimit int = 500
@description('Organizations to sweep, comma-separated ids: the app login cannot list them (RLS, no grant on Organization)')
param cleanupOrgIds string

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: environmentName }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: appIdentityName }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageAccountName }

resource cleanup 'Microsoft.App/jobs@2024-03-01' = {
  name: 'mjeepc-dev-selfie-cleanup'
  location: location
  tags: { project: 'mje-epc', environment: 'dev', purpose: 'selfie-retention' }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appIdentity.id}': {} } }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: { cronExpression: cronExpression, parallelism: 1, replicaCompletionCount: 1 }
      replicaRetryLimit: 0
      replicaTimeout: 600
      registries: [{ server: registry.properties.loginServer, identity: appIdentity.id }]
    }
    template: {
      containers: [{
        name: 'selfie-cleanup'
        image: imageReference
        command: ['node', 'dist/cleanup-selfies.js']
        args: dryRun ? ['--dry-run'] : []
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'AZURE_CLIENT_ID', value: appIdentity.properties.clientId }
          { name: 'PGHOST', value: postgresFqdn }
          { name: 'PGDATABASE', value: 'mje' }
          { name: 'PGUSER', value: appIdentity.name }
          { name: 'BLOB_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
          { name: 'BLOB_EVIDENCE_CONTAINER', value: 'evidence' }
          { name: 'SELFIE_RETENTION_DAYS', value: string(selfieRetentionDays) }
          { name: 'SELFIE_GRACE_MINUTES', value: string(selfieGraceMinutes) }
          { name: 'CLEANUP_BATCH_LIMIT', value: string(batchLimit) }
          { name: 'CLEANUP_ORG_IDS', value: cleanupOrgIds }
        ]
      }]
    }
  }
}

output jobName string = cleanup.name
