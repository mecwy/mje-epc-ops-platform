import type { ContainerClient } from '@azure/storage-blob';
import { RestError } from '@azure/storage-blob';
import { describe, expect, it } from 'vitest';
import { AzurePhotoBlobStore } from './photo-blobs.js';

/**
 * A RestError thrown by a second copy of the storage SDK: same name and status code, but not an
 * instance of the class this module imports. The local dev server builds its container client
 * from the SDK's CommonJS copy, so its storage errors arrive like this.
 */
const foreignRestError = (statusCode: number) =>
  Object.assign(new Error(`storage ${statusCode}`), {
    name: 'RestError',
    statusCode,
  });

/** A RestError from the SDK copy this module imports. */
const ownRestError = (statusCode: number) =>
  new RestError(`storage ${statusCode}`, { statusCode });

const errorSources = [
  ['the SDK copy this module imports', ownRestError],
  ['another copy of the SDK', foreignRestError],
] as const;

type FakeBlob = {
  uploadData?: () => Promise<unknown>;
  downloadToBuffer?: () => Promise<Buffer>;
  getProperties?: () => Promise<{ contentType?: string }>;
  setHTTPHeaders?: (headers: unknown) => Promise<unknown>;
};

const storeWith = (blob: FakeBlob) =>
  new AzurePhotoBlobStore({
    getBlockBlobClient: () => blob,
  } as unknown as ContainerClient);

const bytes = Buffer.from('jpeg bytes');

describe('AzurePhotoBlobStore.put', () => {
  for (const [source, make] of errorSources) {
    it(`accepts an existing key that holds the same bytes (conflict from ${source})`, async () => {
      const headerWrites: unknown[] = [];
      const store = storeWith({
        uploadData: async () => {
          throw make(409);
        },
        downloadToBuffer: async () => Buffer.from(bytes),
        getProperties: async () => ({ contentType: 'image/jpeg' }),
        setHTTPHeaders: async (headers) => {
          headerWrites.push(headers);
        },
      });
      await expect(
        store.put('org/sha', bytes, 'image/jpeg'),
      ).resolves.toBeUndefined();
      expect(headerWrites).toEqual([]);
    });

    it(`refuses an existing key that holds other bytes (conflict from ${source})`, async () => {
      const store = storeWith({
        uploadData: async () => {
          throw make(412);
        },
        downloadToBuffer: async () => Buffer.from('other bytes'),
      });
      await expect(store.put('org/sha', bytes, 'image/jpeg')).rejects.toThrow(
        /does not hold the bytes/,
      );
    });

    it(`rethrows other storage failures (from ${source})`, async () => {
      const store = storeWith({
        uploadData: async () => {
          throw make(500);
        },
      });
      await expect(
        store.put('org/sha', bytes, 'image/jpeg'),
      ).rejects.toMatchObject({
        statusCode: 500,
      });
    });
  }

  it('rethrows an error that is not a storage error', async () => {
    const store = storeWith({
      uploadData: async () => {
        throw new Error('network');
      },
    });
    await expect(store.put('org/sha', bytes, 'image/jpeg')).rejects.toThrow(
      'network',
    );
  });
});

describe('AzurePhotoBlobStore.get', () => {
  for (const [source, make] of errorSources) {
    it(`returns null for a missing key (not found from ${source})`, async () => {
      const store = storeWith({
        getProperties: async () => {
          throw make(404);
        },
      });
      await expect(store.get('org/sha')).resolves.toBeNull();
    });

    it(`rethrows other storage failures (from ${source})`, async () => {
      const store = storeWith({
        getProperties: async () => {
          throw make(403);
        },
      });
      await expect(store.get('org/sha')).rejects.toMatchObject({
        statusCode: 403,
      });
    });
  }
});

describe('AzurePhotoBlobStore.url', () => {
  // Construction only (no storage call). Shows why local tooling checks the built URL and the
  // exact field spelling: the SDK ignores a lower-case `blobendpoint` and builds a public URL.
  it('is the destination the SDK built from the connection string', () => {
    const loopback = AzurePhotoBlobStore.fromConnectionString(
      'DefaultEndpointsProtocol=http;AccountName=TEST;AccountKey=VEVTVA==;BlobEndpoint=http://127.0.0.1:11001/TEST',
      'evidence-dev',
    );
    expect(new URL(loopback.url).hostname).toBe('127.0.0.1');
    const misspelled = AzurePhotoBlobStore.fromConnectionString(
      'DefaultEndpointsProtocol=https;AccountName=TEST;AccountKey=VEVTVA==;EndpointSuffix=core.windows.net;blobendpoint=http://127.0.0.1:11001/TEST',
      'evidence-dev',
    );
    expect(new URL(misspelled.url).hostname).toBe('test.blob.core.windows.net');
  });
});
