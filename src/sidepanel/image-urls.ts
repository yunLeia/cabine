import { getImage } from '../shared/images';

// Blobs can't go in an <img> directly: each one gets an object URL, created once
// per image and revoked when the image is no longer shown, so it doesn't leak.
const urls = new Map<string, string>();

export async function syncImageUrls(imageIds: string[]): Promise<void> {
  const wanted = new Set(imageIds);
  for (const [id, url] of urls) {
    if (!wanted.has(id)) {
      URL.revokeObjectURL(url);
      urls.delete(id);
    }
  }
  await Promise.all(
    [...wanted].filter((id) => !urls.has(id)).map(async (id) => {
      const blob = await getImage(id);
      if (blob) urls.set(id, URL.createObjectURL(blob));
    }),
  );
}

export const imageUrl = (imageId?: string) => (imageId ? urls.get(imageId) : undefined);
