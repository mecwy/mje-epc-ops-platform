import {
  BlobServiceClient,
  RestError,
  type ContainerClient,
} from '@azure/storage-blob';
import type { TokenCredential } from '@azure/identity';
import type { PhotoBlob, SelfieBlobStore } from '@mje/domain';

export const EVIDENCE_CONTAINER = 'evidence';

/**
 * Photo bytes in a private Azure Blob container. Keys are content-addressed (`${orgId}/${sha256}`,
 * thumbnails `${orgId}/${thumbSha256}.thumb`), so a key is written once and never overwritten;
 * an existing key is accepted only when it holds the same bytes. No URL or SAS is ever
 * handed out: the API reads the bytes and serves them after its own access check.
 * In Azure the app authenticates with its managed identity (no account key); the connection
 * string form is for the local Azurite emulator only.
 */
export class AzurePhotoBlobStore implements SelfieBlobStore {
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
    const blob = this.container.getBlockBlobClient(key);
    try {
      await blob.uploadData(bytes, {
        blobHTTPHeaders: { blobContentType: contentType },
        conditions: { ifNoneMatch: '*' },
      });
      return;
    } catch (error) {
      if (
        !(error instanceof RestError) ||
        (error.statusCode !== 409 && error.statusCode !== 412)
      )
        throw error;
    }
    // The key exists, e.g. left by an upload whose database write rolled back. Content addressing
    // means it must hold exactly these bytes; anything else is refused, never overwritten.
    const existing = await blob.downloadToBuffer();
    if (!existing.equals(Buffer.from(bytes)))
      throw new Error('Existing blob does not hold the bytes its key names');
    const properties = await blob.getProperties();
    if (properties.contentType !== contentType)
      await blob.setHTTPHeaders({ blobContentType: contentType });
  }

  /**
   * Selfie retention only (A6b; keys under `selfie/`): a key that is already gone counts as
   * deleted. Evidence photos are never deleted. Needs delete permission on the container
   * (an infra item for the worker identity).
   */
  async delete(key: string) {
    if (!key.startsWith('selfie/'))
      throw new Error('Only selfie blobs are ever deleted');
    await this.container.getBlockBlobClient(key).deleteIfExists();
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
