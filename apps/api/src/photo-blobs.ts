import {
  BlobServiceClient,
  RestError,
  type ContainerClient,
} from '@azure/storage-blob';
import type { TokenCredential } from '@azure/identity';
import type { PhotoBlob, PhotoBlobStore } from '@mje/domain';

export const EVIDENCE_CONTAINER = 'evidence';

/**
 * Photo bytes in a private Azure Blob container. Keys are content-addressed
 * (`${orgId}/${sha256}`), so a key is written once and never overwritten. No URL or SAS is ever
 * handed out: the API reads the bytes and serves them after its own access check.
 * In Azure the app authenticates with its managed identity (no account key); the connection
 * string form is for the local Azurite emulator only.
 */
export class AzurePhotoBlobStore implements PhotoBlobStore {
  constructor(private readonly container: ContainerClient) {}

  static fromConnectionString(
    connectionString: string,
    container = EVIDENCE_CONTAINER,
  ) {
    return new AzurePhotoBlobStore(
      BlobServiceClient.fromConnectionString(
        connectionString,
      ).getContainerClient(container),
    );
  }
  static fromAccountUrl(
    accountUrl: string,
    credential: TokenCredential,
    container = EVIDENCE_CONTAINER,
  ) {
    return new AzurePhotoBlobStore(
      new BlobServiceClient(accountUrl, credential).getContainerClient(
        container,
      ),
    );
  }

  /** Local emulator only: creates the container as private (no anonymous access). */
  async ensureContainer() {
    await this.container.createIfNotExists();
  }
  /** Deletes the container; used by TEST runs against their own emulator container. */
  async deleteContainer() {
    await this.container.deleteIfExists();
  }

  async put(key: string, bytes: Uint8Array, contentType: string) {
    try {
      await this.container.getBlockBlobClient(key).uploadData(bytes, {
        blobHTTPHeaders: { blobContentType: contentType },
        conditions: { ifNoneMatch: '*' },
      });
    } catch (error) {
      // Same key = same bytes (content-addressed): an existing blob is already the right one.
      if (
        error instanceof RestError &&
        (error.statusCode === 409 || error.statusCode === 412)
      )
        return;
      throw error;
    }
  }

  async get(key: string): Promise<PhotoBlob | null> {
    try {
      const blob = this.container.getBlockBlobClient(key);
      const properties = await blob.getProperties();
      const bytes = await blob.downloadToBuffer();
      return {
        bytes,
        contentType: properties.contentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (error instanceof RestError && error.statusCode === 404) return null;
      throw error;
    }
  }
}
