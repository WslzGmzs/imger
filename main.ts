import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { serveFile } from "https://deno.land/std@0.224.0/http/file_server.ts";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

const KV_CHUNK_SIZE = 50 * 1024; // 50KB, slightly less than 55KB limit
const kv = await Deno.openKv();

// Simple in-memory cache (for demonstration)
// In a real-world scenario, consider a more robust LRU cache
const cache = new Map<string, Uint8Array>();
const CACHE_TTL = 60 * 1000; // Cache entries expire after 60 seconds

interface ImageMeta {
  name: string;
  type: string;
  size: number;
  chunks: number;
  uploadedAt: number;
  md5: string; // Add MD5 hash to metadata
  completed: boolean; // Add completion flag
}

// Function to calculate MD5 hash of a Uint8Array
async function calculateMd5(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("MD5", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const md5Hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return md5Hash;
}


// CORS headers helper function
function getCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

async function uploadHandler(request: Request): Promise<Response> {
  try {
    const formData = await request.formData();
    const files = formData.getAll("file"); // Get all entries with the name "file"

    if (!files || files.length === 0) {
      return new Response("No files uploaded", {
        status: 400,
        headers: getCorsHeaders()
      });
    }

    const results: { name: string; url?: string; error?: string; status: string }[] = [];
    const origin = new URL(request.url).origin;

    for (const file of files) {
      if (typeof file === "string") {
        results.push({ name: "unknown", error: "Invalid file data", status: "error" });
        continue;
      }

      try {
        const imageBytes = new Uint8Array(await file.arrayBuffer());
        const md5Hash = await calculateMd5(imageBytes);

        // Check if image with this MD5 hash already exists
        const existingImageEntry = await kv.get<string>(["md5_to_id", md5Hash]);

        if (existingImageEntry.value) {
          // MD5 exists, check if the image is completed
          const existingImageId = existingImageEntry.value;
          const existingMetaEntry = await kv.get<ImageMeta>(["images", existingImageId, "meta"]);

          if (existingMetaEntry.value && existingMetaEntry.value.completed) {
            // Image is completed, return existing URL
            const imageUrl = `${origin}/image/${existingImageId}`;
            console.log(`File ${file.name} (MD5: ${md5Hash}) already exists and is completed. Returning existing URL.`);
            results.push({ name: file.name, url: imageUrl, status: "cached" });
          } else {
            // Image exists but is not completed, or metadata is missing.
            // Proceed with storing the new upload, potentially overwriting incomplete data.
            console.log(`File ${file.name} (MD5: ${md5Hash}) exists but is not completed. Overwriting.`);
            const imageId = existingImageId; // Use the existing ID

            const imageMeta: ImageMeta = {
              name: file.name,
              type: file.type,
              size: imageBytes.byteLength,
              chunks: Math.ceil(imageBytes.byteLength / KV_CHUNK_SIZE),
              uploadedAt: Date.now(),
              md5: md5Hash, // Store MD5 hash in metadata
              completed: false, // Initialize completion flag to false
            };

            const kvOperations = kv.atomic();

            // Store metadata (will overwrite if exists)
            kvOperations.set(["images", imageId, "meta"], imageMeta);

            // MD5 to ID mapping already exists, no need to set again in atomic op

            await kvOperations.commit();

            // Store chunks individually (will overwrite if exists)
            for (let i = 0; i < imageMeta.chunks; i++) {
              const start = i * KV_CHUNK_SIZE;
              const end = Math.min(start + KV_CHUNK_SIZE, imageBytes.byteLength);
              const chunk = imageBytes.slice(start, end);
              await kv.set(["images", imageId, "chunk", i], chunk);
            }

            // Mark image as completed after all chunks are stored
            await kv.set(["images", imageId, "meta"], { ...imageMeta, completed: true });

            // Extract file extension from original name
            const fileNameParts = file.name.split('.');
            const fileExtension = fileNameParts.length > 1 ? fileNameParts.pop() : '';
            const imageUrl = `${origin}/image/${imageId}${fileExtension ? '.' + fileExtension : ''}`;
            results.push({ name: file.name, url: imageUrl, status: "overwritten" });
          }
        } else {
          // Image does not exist, store it
          const imageId = crypto.randomUUID();
          const imageMeta: ImageMeta = {
            name: file.name,
            type: file.type,
            size: imageBytes.byteLength,
            chunks: Math.ceil(imageBytes.byteLength / KV_CHUNK_SIZE),
            uploadedAt: Date.now(),
            md5: md5Hash, // Store MD5 hash in metadata
            completed: false, // Initialize completion flag to false
          };

          const kvOperations = kv.atomic();

          // Store metadata
          kvOperations.set(["images", imageId, "meta"], imageMeta);

          // Store MD5 to ID mapping
          kvOperations.set(["md5_to_id", md5Hash], imageId);

          await kvOperations.commit();

          // Store chunks individually
          for (let i = 0; i < imageMeta.chunks; i++) {
            const start = i * KV_CHUNK_SIZE;
            const end = Math.min(start + KV_CHUNK_SIZE, imageBytes.byteLength);
            const chunk = imageBytes.slice(start, end);
            await kv.set(["images", imageId, "chunk", i], chunk);
          }

          // Mark image as completed after all chunks are stored
          await kv.set(["images", imageId, "meta"], { ...imageMeta, completed: true });

          // Extract file extension from original name
          const fileNameParts = file.name.split('.');
          const fileExtension = fileNameParts.length > 1 ? fileNameParts.pop() : '';
          const imageUrl = `${origin}/image/${imageId}${fileExtension ? '.' + fileExtension : ''}`;
          results.push({ name: file.name, url: imageUrl, status: "uploaded" });
        }

      } catch (error) {
        console.error(`Error processing file ${file.name}:`, error);
        results.push({ name: file.name, error: error.message, status: "error" });
      }
    }

    // Determine overall status code
    const status = results.some(r => r.status === "error") ? 500 : 200;

    return new Response(JSON.stringify(results), {
      status: status,
      headers: {
        "Content-Type": "application/json",
        ...getCorsHeaders()
      },
    });

  } catch (error) {
    console.error("Upload handler error:", error);
    return new Response("Internal Server Error", {
      status: 500,
      headers: getCorsHeaders()
    });
  }
}

async function serveImage(request: Request, imageId: string): Promise<Response> {
  try {
    // Check cache first
    const cachedImage = cache.get(imageId);
    if (cachedImage) {
      console.log(`Serving image ${imageId} from cache`);
      const meta = await kv.get<ImageMeta>(["images", imageId, "meta"]);
       if (meta.value) {
         return new Response(cachedImage, {
           headers: {
             "Content-Type": meta.value.type,
             ...getCorsHeaders()
           },
         });
       }
    }

    const metaEntry = await kv.get<ImageMeta>(["images", imageId, "meta"]);
    if (!metaEntry.value || !metaEntry.value.completed) {
      return new Response("Image not found or not yet completed", {
        status: 404,
        headers: getCorsHeaders()
      });
    }

    const imageMeta = metaEntry.value;
    const chunks: Uint8Array[] = [];

    for (let i = 0; i < imageMeta.chunks; i++) {
      const chunkEntry = await kv.get<Uint8Array>(["images", imageId, "chunk", i]);
      if (!chunkEntry.value) {
        // This should not happen if metadata is present, but handle defensively
        console.error(`Missing chunk ${i} for image ${imageId}`);
        return new Response("Image data incomplete", {
          status: 500,
          headers: getCorsHeaders()
        });
      }
      chunks.push(chunkEntry.value);
    }

    const fullImage = new Uint8Array(imageMeta.size);
    let offset = 0;
    for (const chunk of chunks) {
      fullImage.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Store in cache
    cache.set(imageId, fullImage);
    // Simple cache expiration (in a real app, use setInterval or similar)
    setTimeout(() => {
        cache.delete(imageId);
        console.log(`Cache expired for image ${imageId}`);
    }, CACHE_TTL);


    return new Response(fullImage, {
      headers: {
        "Content-Type": imageMeta.type,
        ...getCorsHeaders()
      },
    });

  } catch (error) {
    console.error("Serve image error:", error);
    return new Response("Internal Server Error", {
      status: 500,
      headers: getCorsHeaders()
    });
  }
}

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Handle CORS preflight requests
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: getCorsHeaders(),
    });
  }

  if (request.method === "POST" && url.pathname === "/upload") {
    return uploadHandler(request);
  }

  if (url.pathname.startsWith("/image/")) {
    // Extract UUID from the new URL format /[UUID].[extension]
    const pathParts = url.pathname.split("/");
    const filenameWithExtension = pathParts.pop(); // Get the last part, e.g., "a1b2c3d4...jpg"
    if (filenameWithExtension) {
      const filenameParts = filenameWithExtension.split('.');
      const imageId = filenameParts[0]; // The UUID is the first part
      return serveImage(request, imageId);
    }
  }

  // Serve the index.html file for the root path
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return serveFile(request, "./index.html");
  }

  return new Response("Not Found", {
    status: 404,
    headers: getCorsHeaders()
  });
}

console.log("Listening on http://localhost:8000");
serve(handler);
