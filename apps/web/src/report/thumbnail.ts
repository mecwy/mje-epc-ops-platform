/** Long edge of a client-made thumbnail, in pixels. */
export const THUMB_EDGE = 320;
/** The server refuses larger thumbnails. */
export const THUMB_MAX_BYTES = 300 * 1024;
/** Photos above this are refused by the server; checked here first. */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const PHOTO_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

/** A photo the server would refuse outright is not sent: too large, or not a photo type. */
export function checkPhotoFile(file: {
  size: number;
  type: string;
}): 'PHOTO_TOO_LARGE' | 'UNSUPPORTED_MEDIA' | null {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type))
    return 'UNSUPPORTED_MEDIA';
  if (file.size === 0) return 'UNSUPPORTED_MEDIA';
  if (file.size > PHOTO_MAX_BYTES) return 'PHOTO_TOO_LARGE';
  return null;
}

async function decode(file: Blob): Promise<
  CanvasImageSource & {
    width: number;
    height: number;
  }
> {
  if (typeof createImageBitmap === 'function')
    return createImageBitmap(file, { imageOrientation: 'from-image' });
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A small JPEG for lists, made on the device (the server never decodes images). A photo the
 * browser cannot decode (for example HEIC outside Safari) gets no thumbnail; that is allowed.
 */
export async function makeThumbnail(file: Blob): Promise<Blob | null> {
  try {
    const img = await decode(file);
    const long = Math.max(img.width, img.height);
    if (!long) return null;
    const k = Math.min(1, THUMB_EDGE / long);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * k));
    canvas.height = Math.max(1, Math.round(img.height * k));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if ('close' in img && typeof img.close === 'function') img.close();
    const blob = await new Promise<Blob | null>((r) =>
      canvas.toBlob(r, 'image/jpeg', 0.75),
    );
    return blob && blob.size > 0 && blob.size <= THUMB_MAX_BYTES ? blob : null;
  } catch {
    return null;
  }
}
