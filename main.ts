import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { serveFile } from "https://deno.land/std@0.224.0/http/file_server.ts";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

// Deno KV has a chunk size limit, we set it slightly lower to be safe.
const KV_CHUNK_SIZE = 63 * 1024; // 63KB, Deno KV value size limit is 64KB
const kv = await Deno.openKv();

// In-memory cache for frequently accessed images to reduce KV reads.
const cache = new Map<string, { data: Uint8Array, type: string, timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ITEMS = 100; // Prevent memory exhaustion

// Interface for image metadata stored in KV.
interface ImageMeta {
  name: string;
  type: string;
  size: number;
  chunks: number;
  uploadedAt: number;
  md5: string;
  completed: boolean;
  deleteToken: string; // Secret token for authorizing deletion
}

// --- Cache Management ---
function cleanCache() {
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            cache.delete(key);
        }
    }
    // If cache is still too large, remove oldest items
    while (cache.size > CACHE_MAX_ITEMS) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey) {
            cache.delete(oldestKey);
        } else {
            break;
        }
    }
}
setInterval(cleanCache, CACHE_TTL); // Periodically clean the cache

// --- Utility Functions ---
async function calculateMd5(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("MD5", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function getCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// --- Route Handlers ---

/**
 * Handles file uploads, checks for duplicates via MD5,
 * chunks files, and stores them in Deno KV.
 */
async function uploadHandler(request: Request): Promise<Response> {
  try {
    const formData = await request.formData();
    const files = formData.getAll("file");

    if (!files || files.length === 0) {
      return new Response(JSON.stringify({ error: "No files uploaded" }), { status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });
    }

    const results = [];
    const origin = new URL(request.url).origin;

    for (const file of files) {
      if (typeof file === "string") {
        results.push({ name: "unknown", error: "Invalid file data" });
        continue;
      }

      try {
        const imageBytes = new Uint8Array(await file.arrayBuffer());
        const md5Hash = await calculateMd5(imageBytes);
        const existingImageEntry = await kv.get<string>(["md5_to_id", md5Hash]);

        // If a completed image with the same hash exists, return its URL.
        if (existingImageEntry.value) {
          const existingMeta = await kv.get<ImageMeta>(["images", existingImageEntry.value, "meta"]);
          if (existingMeta.value?.completed) {
            console.log(`Duplicate found for ${file.name}. Returning existing URL.`);
            const fileExtension = existingMeta.value.name.split('.').pop() || '';
            const imageUrl = `${origin}/image/${existingImageEntry.value}${fileExtension ? '.' + fileExtension : ''}`;
            results.push({
              name: existingMeta.value.name,
              url: imageUrl,
              id: existingImageEntry.value,
              deleteToken: existingMeta.value.deleteToken, // Return existing token
              status: "duplicate"
            });
            continue;
          }
        }

        // Otherwise, proceed with the upload.
        const imageId = crypto.randomUUID();
        const deleteToken = crypto.randomUUID();
        const imageMeta: ImageMeta = {
          name: file.name,
          type: file.type,
          size: imageBytes.byteLength,
          chunks: Math.ceil(imageBytes.byteLength / KV_CHUNK_SIZE),
          uploadedAt: Date.now(),
          md5: md5Hash,
          completed: false,
          deleteToken: deleteToken,
        };

        // Use an atomic operation to ensure metadata and MD5 map are set together.
        const atomicOp = kv.atomic()
          .set(["images", imageId, "meta"], imageMeta)
          .set(["md5_to_id", md5Hash], imageId);
        const res = await atomicOp.commit();
        if (!res.ok) {
            throw new Error("Failed to commit initial metadata to KV.");
        }

        // Store chunks sequentially.
        for (let i = 0; i < imageMeta.chunks; i++) {
          const start = i * KV_CHUNK_SIZE;
          const end = start + KV_CHUNK_SIZE;
          const chunk = imageBytes.slice(start, end);
          await kv.set(["images", imageId, "chunk", i], chunk);
        }

        // Mark the upload as complete.
        await kv.set(["images", imageId, "meta"], { ...imageMeta, completed: true });

        const fileExtension = file.name.split('.').pop() || '';
        const imageUrl = `${origin}/image/${imageId}${fileExtension ? '.' + fileExtension : ''}`;
        results.push({ name: file.name, url: imageUrl, id: imageId, deleteToken, status: "uploaded" });

      } catch (error) {
        console.error(`Error processing file ${file.name}:`, error);
        results.push({ name: file.name, error: error.message });
      }
    }

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { "Content-Type": "application/json", ...getCorsHeaders() },
    });

  } catch (error) {
    console.error("Upload handler error:", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });
  }
}

/**
 * Serves an image by reconstructing it from chunks stored in Deno KV.
 * Uses an in-memory cache to speed up delivery of popular images.
 */
async function serveImage(imageId: string): Promise<Response> {
  try {
    // 1. Check cache
    const cached = cache.get(imageId);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      return new Response(cached.data, { headers: { "Content-Type": cached.type, ...getCorsHeaders() } });
    }

    // 2. Fetch metadata from KV
    const metaEntry = await kv.get<ImageMeta>(["images", imageId, "meta"]);
    if (!metaEntry.value?.completed) {
      return new Response("Image not found or upload incomplete.", { status: 404, headers: getCorsHeaders() });
    }
    const imageMeta = metaEntry.value;

    // 3. Fetch all chunks concurrently
    const chunkPromises = [];
    for (let i = 0; i < imageMeta.chunks; i++) {
      chunkPromises.push(kv.get<Uint8Array>(["images", imageId, "chunk", i]));
    }
    const chunkEntries = await Promise.all(chunkPromises);

    // 4. Reconstruct the image
    const fullImage = new Uint8Array(imageMeta.size);
    let offset = 0;
    for (const chunkEntry of chunkEntries) {
      if (!chunkEntry.value) {
        console.error(`Missing chunk for image ${imageId}`);
        return new Response("Image data is incomplete.", { status: 500, headers: getCorsHeaders() });
      }
      fullImage.set(chunkEntry.value, offset);
      offset += chunkEntry.value.byteLength;
    }

    // 5. Update cache
    cache.set(imageId, { data: fullImage, type: imageMeta.type, timestamp: Date.now() });

    return new Response(fullImage, { headers: { "Content-Type": imageMeta.type, ...getCorsHeaders() } });
  } catch (error) {
    console.error(`Serve image error for ${imageId}:`, error);
    return new Response("Internal Server Error", { status: 500, headers: getCorsHeaders() });
  }
}

/**
 * Deletes an image and its associated data from Deno KV
 * if the correct delete token is provided.
 */
async function deleteImageHandler(imageId: string, deleteToken: string): Promise<Response> {
    try {
        const metaEntry = await kv.get<ImageMeta>(["images", imageId, "meta"]);
        if (!metaEntry.value) {
            return new Response(JSON.stringify({ error: "Image not found" }), { status: 404, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });
        }

        const imageMeta = metaEntry.value;
        if (imageMeta.deleteToken !== deleteToken) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });
        }

        // Create an atomic operation to delete all data
        const atomicOp = kv.atomic();
        atomicOp.delete(["images", imageId, "meta"]);
        atomicOp.delete(["md5_to_id", imageMeta.md5]);
        for (let i = 0; i < imageMeta.chunks; i++) {
            atomicOp.delete(["images", imageId, "chunk", i]);
        }

        const res = await atomicOp.commit();
        if (!res.ok) {
            throw new Error("Failed to commit deletion to KV.");
        }

        // Also remove from cache if present
        cache.delete(imageId);

        console.log(`Successfully deleted image ${imageId}`);
        return new Response(JSON.stringify({ message: "Image deleted successfully" }), { status: 200, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });

    } catch (error) {
        console.error(`Delete image error for ${imageId}:`, error);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });
    }
}


/**
 * Main request handler, routing requests to the appropriate function.
 */
async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders() });
  }

  if (request.method === "POST" && pathname === "/upload") {
    return uploadHandler(request);
  }

  const imageRouteMatch = pathname.match(/^\/image\/([0-9a-fA-F-]+)(\.\w+)?$/);
  if (request.method === "GET" && imageRouteMatch) {
    const imageId = imageRouteMatch[1];
    return serveImage(imageId);
  }

  const deleteRouteMatch = pathname.match(/^\/api\/image\/([0-9a-fA-F-]+)\/([0-9a-fA-F-]+)$/);
  if (request.method === "DELETE" && deleteRouteMatch) {
      const [, imageId, deleteToken] = deleteRouteMatch;
      return deleteImageHandler(imageId, deleteToken);
  }

  if (pathname === "/" || pathname === "/index.html") {
    try {
        // Deno Deploy requires a relative path from the entrypoint file.
        return await serveFile(request, new URL("./index.html", import.meta.url).pathname);
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
            return new Response("index.html not found.", { status: 404 });
        }
        return new Response("Error serving file.", { status: 500 });
    }
  }

  return new Response("Not Found", { status: 404, headers: getCorsHeaders() });
}

console.log("Image server running on http://localhost:8000");
serve(handler);
