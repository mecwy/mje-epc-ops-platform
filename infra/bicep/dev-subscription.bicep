targetScope = 'subscription'
param location string = 'francecentral'
param resourceGroupName string = 'mjeepc-dev'
resource group 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: { project: 'mje-epc', environment: 'dev', purpose: 'owner-alpha' }
}
module foundation 'dev-alpha.bicep' = {
  name: 'dev-alpha-foundation'
  scope: group
  params: { location: location }
}
