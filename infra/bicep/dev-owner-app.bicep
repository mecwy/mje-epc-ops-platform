// Owner Alpha only. Deploy after the foundation, SQL migration and non-owner Entra role bootstrap.
targetScope = 'resourceGroup'
param location string = resourceGroup().location
param environmentName string = 'mjeepc-dev-aca'
param registryName string
param appIdentityName string = 'mjeepc-dev-app'
param postgresFqdn string
param tenantId string
param apiClientId string
param spaClientId string
@description('ACR image reference pinned by digest, for example registry.azurecr.io/owner-alpha@sha256:...')
param imageReference string
@minLength(7)
param sourceRevision string
@description('The foundation\'s storage account; the app identity holds Storage Blob Data Contributor on its private "evidence" container only.')
param storageAccountName string
@description('Explicit opt-in for confirmed report location saves; independent of weather. Frontend entry is separately enabled at image build time.')
param reportLocationEnabled bool = false

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: appIdentityName
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'mjeepc-dev-owner-alpha'
  location: location
  tags: { project: 'mje-epc', environment: 'dev', purpose: 'owner-alpha' }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${appIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registry.properties.loginServer, identity: appIdentity.id }]
      ingress: {
        external: true
        targetPort: 3300
        transport: 'auto'
        allowInsecure: false
      }
    }
    template: {
      containers: [{
        name: 'web-api'
        image: imageReference
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'HOST', value: '0.0.0.0' }
          { name: 'PORT', value: '3300' }
          { name: 'WEB_ROOT', value: '/app/web' }
          { name: 'SOURCE_REVISION', value: sourceRevision }
          { name: 'ALPHA_ENABLED', value: 'true' }
            { name: 'REPORT_LOCATION_ENABLED', value: reportLocationEnabled ? 'true' : 'false' }
          { name: 'ENTRA_TENANT_ID', value: tenantId }
          { name: 'ENTRA_API_CLIENT_ID', value: apiClientId }
          { name: 'ENTRA_SPA_CLIENT_ID', value: spaClientId }
          { name: 'AZURE_CLIENT_ID', value: appIdentity.properties.clientId }
          { name: 'PGHOST', value: postgresFqdn }
          { name: 'PGDATABASE', value: 'mje' }
          { name: 'PGUSER', value: appIdentity.name }
          // Photo bytes through the app's managed identity; no key or connection string.
          { name: 'BLOB_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
          { name: 'BLOB_EVIDENCE_CONTAINER', value: 'evidence' }
          // The ingress appends the real client to X-Forwarded-For; cold starts add one internal hop
          // from 100.64.0.0/10 after it. Trust only loopback and that range (see apps/api trust-proxy.ts).
          { name: 'TRUST_PROXY_SUBNETS', value: 'loopback,100.64.0.0/10' }
        ]
        probes: [{
          type: 'Liveness'
          httpGet: { path: '/health/live', port: 3300, httpHeaders: [] }
          initialDelaySeconds: 10
          periodSeconds: 20
          failureThreshold: 3
        }]
      }]
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}

output url string = 'https://${app.properties.configuration.ingress.fqdn}'
