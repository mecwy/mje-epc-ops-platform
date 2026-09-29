export type ImageKind = 'photo' | 'thumbnail';
type Fetch = (photoId: string, which: ImageKind) => Promise<Blob>;

interface Entry {
  refs: number;
  url: Promise<string | null>;
}

/**
 * Object URLs for photo bytes fetched through the API with the bearer token (an <img> cannot
 * send it, and no token ever goes into a URL). Each URL is reference-counted and revoked when
 * its last user releases it. Thumbnail bytes (small) are kept for the workspace so lists do not
 * fetch them again; full photos are not kept.
 */
export class ImageCache {
  private entries = new Map<string, Entry>();
  private thumbs = new Map<string, Blob>();

  constructor(
    private readonly fetchImage: Fetch,
    private readonly create: (b: Blob) => string = (b) =>
      URL.createObjectURL(b),
    private readonly revoke: (url: string) => void = (u) =>
      URL.revokeObjectURL(u),
  ) {}

  /** A thumbnail made on this device for a photo it just uploaded. */
  seed(photoId: string, thumb: Blob) {
    this.thumbs.set(photoId, thumb);
  }

  private async bytes(photoId: string, which: ImageKind): Promise<Blob> {
    if (which === 'thumbnail') {
      const kept = this.thumbs.get(photoId);
      if (kept) return kept;
    }
    const blob = await this.fetchImage(photoId, which);
    if (which === 'thumbnail') this.thumbs.set(photoId, blob);
    return blob;
  }

  /** An object URL for the image, or null when it cannot be had (none, refused, offline). */
  acquire(photoId: string, which: ImageKind): Promise<string | null> {
    const key = `${which}:${photoId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        refs: 0,
        url: this.bytes(photoId, which).then(
          (b) => this.create(b),
          () => null,
        ),
      };
      this.entries.set(key, entry);
    }
    entry.refs++;
    return entry.url;
  }

  release(photoId: string, which: ImageKind) {
    const key = `${which}:${photoId}`;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.entries.delete(key);
    void entry.url.then((u) => u && this.revoke(u));
  }

  /** Workspace closed: revoke every URL still held (in-flight ones once they exist). */
  dispose() {
    for (const entry of this.entries.values())
      void entry.url.then((u) => u && this.revoke(u));
    this.entries.clear();
    this.thumbs.clear();
  }
}
