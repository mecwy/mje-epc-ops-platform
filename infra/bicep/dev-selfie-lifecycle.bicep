// Storage lifecycle backstop for selfie blobs (design C25): a block blob under evidence/selfie/
// that has not been modified for `selfieBackstopDays` is deleted by the storage service, for the
// few an interrupted upload left without a row. The sweep (dev-selfie-cleanup-job.bicep) deletes
// selfies at SELFIE_RETENTION_DAYS with an audit row; this rule only catches what has no row, so
// the backstop must be longer than the retention. The value comes from @mje/domain
// (SELFIE_BLOB_BACKSTOP_DAYS); the README shows how to pass it. Deploying is a separate Owner step.
targetScope = 'resourceGroup'
param storageAccountName string
@description('SELFIE_BLOB_BACKSTOP_DAYS from @mje/domain (the single source)')
param selfieBackstopDays int

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageAccountName }

resource policy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [{
        enabled: true
        name: 'selfie-backstop'
        type: 'Lifecycle'
        definition: {
          filters: { blobTypes: ['blockBlob'], prefixMatch: ['evidence/selfie/'] }
          actions: {
            baseBlob: { delete: { daysAfterModificationGreaterThan: selfieBackstopDays } }
            // The account keeps blob versions: a deleted selfie's versions stay until this removes them.
            version: { delete: { daysAfterCreationGreaterThan: selfieBackstopDays } }
          }
        }
      }]
    }
  }
}
