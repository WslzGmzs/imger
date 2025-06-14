import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { serveFile } from "https://deno.land/std@0.224.0/http/file_server.ts";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

const KV_CHUNK_SIZE = 63 * 1024; // 63KB
const kv = await Deno.openKv();

const cache = new Map<string, { data: Uint8Array, type: string, timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ITEMS = 100;

interface ImageMeta {
  name: string;
  type: string;
  size: number;
  chunks: number;
  uploadedAt: number;
  md5: string;
  completed: boolean;
  deleteToken: string;
}

function cleanCache() {
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            cache.delete(key);
        }
    }
    while (cache.size > CACHE_MAX_ITEMS) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey) cache.delete(oldestKey); else break;
    }
}
setInterval(cleanCache, CACHE_TTL / 2);

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

async function uploadHandler(request: Request): Promise<Response> {
  try {
    const formData = await request.formData();
    const files = formData.getAll("file");

    if (!files || files.length === 0) {
      return new Response(JSON.stringify({ error: "No files uploaded" }), { status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });
    }

    const results: Array<{id?: string, name: string; url?: string; error?: string; status: string, deleteToken?: string}> = [];
    const origin = new URL(request.url).origin;

    for (const file of files) {
      if (typeof file === "string") {
        results.push({ name: "unknown", error: "Invalid file data", status: "error" });
        continue;
      }

      try {
        const imageBytes = new Uint8Array(await file.arrayBuffer());
        if (imageBytes.byteLength === 0) {
            results.push({ name: file.name, error: "File is empty", status: "error" });
            continue;
        }
        const md5Hash = await calculateMd5(imageBytes);
        const existingImageEntry = await kv.get<string>(["md5_to_id", md5Hash]);

        if (existingImageEntry.value) {
          const existingMeta = await kv.get<ImageMeta>(["images", existingImageEntry.value, "meta"]);
          if (existingMeta.value?.completed) {
            const fileExtension = existingMeta.value.name.split('.').pop() || '';
            const imageUrl = `${origin}/image/${existingImageEntry.value}${fileExtension ? '.' + fileExtension : ''}`;
            results.push({
              id: existingImageEntry.value,
              name: existingMeta.value.name,
              url: imageUrl,
              deleteToken: existingMeta.value.deleteToken,
              status: "duplicate"
            });
            continue;
          }
        }

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

        const atomicOp = kv.atomic()
          .set(["images", imageId, "meta"], imageMeta)
          .set(["md5_to_id", md5Hash], imageId);
        const commitRes = await atomicOp.commit();
        if (!commitRes.ok) throw new Error("KV Error: Failed to commit initial metadata.");

        for (let i = 0; i < imageMeta.chunks; i++) {
          const start = i * KV_CHUNK_SIZE;
          const end = Math.min(start + KV_CHUNK_SIZE, imageBytes.byteLength);
          await kv.set(["images", imageId, "chunk", i], imageBytes.slice(start, end));
        }

        await kv.set(["images", imageId, "meta"], { ...imageMeta, completed: true });

        const fileExtension = file.name.split('.').pop() || '';
        const imageUrl = `${origin}/image/${imageId}${fileExtension ? '.' + fileExtension : ''}`;
        results.push({ id: imageId, name: file.name, url: imageUrl, deleteToken, status: "uploaded" });

      } catch (error) {
        console.error(`Error processing file ${file.name}:`, error);
        results.push({ name: file.name, error: error.message || "Unknown processing error", status: "error" });
      }
    }
    
    const hasErrors = results.some(r => r.error);
    const allErrors = results.every(r => r.error);
    const hasSuccess = results.some(r => r.url && !r.error);

    let httpStatus = 200; // Default to OK
    if (hasErrors) {
        if (allErrors && results.length > 0) {
            httpStatus = 500; // If all attempts resulted in error, likely server-side
        } else if (hasSuccess) {
            httpStatus = 207; // Multi-Status: some succeeded, some failed
        } else {
             // This case (hasErrors but not allErrors and not hasSuccess) implies results might be empty or only errors
            httpStatus = 500;
        }
    } else if (!hasSuccess && results.length > 0) {
        // No errors, but no successes either (e.g. all duplicates, or some other non-error, non-success status)
        // This might still be a 200 if duplicates are considered "successful" in a way.
        // If only duplicates, 200 is fine.
        if (results.every(r => r.status === 'duplicate')) {
            httpStatus = 200;
        } else {
            httpStatus = 200; // Or a more specific code if needed
        }
    }


    return new Response(JSON.stringify(results), {
      status: httpStatus,
      headers: { "Content-Type": "application/json", ...getCorsHeaders() },
    });

  } catch (error) { // Outer catch for errors like formData parsing
    console.error("Upload handler critical error:", error);
    return new Response(JSON.stringify({ error: "Internal Server Error during upload setup" }), { status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });
  }
}

async function serveImage(imageId: string): Promise<Response> {
  try {
    const cached = cache.get(imageId);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      return new Response(cached.data, { headers: { "Content-Type": cached.type, ...getCorsHeaders() } });
    }

    const metaEntry = await kv.get<ImageMeta>(["images", imageId, "meta"]);
    if (!metaEntry.value?.completed) {
      return new Response("Image not found or upload incomplete.", { status: 404, headers: getCorsHeaders() });
    }
    const imageMeta = metaEntry.value;

    const chunkPromises = Array.from({ length: imageMeta.chunks }, (_, i) =>
      kv.get<Uint8Array>(["images", imageId, "chunk", i])
    );
    const chunkEntries = await Promise.all(chunkPromises);

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

    cache.set(imageId, { data: fullImage, type: imageMeta.type, timestamp: Date.now() });
    return new Response(fullImage, { headers: { "Content-Type": imageMeta.type, ...getCorsHeaders() } });
  } catch (error) {
    console.error(`Serve image error for ${imageId}:`, error);
    return new Response("Internal Server Error", { status: 500, headers: getCorsHeaders() });
  }
}

async function deleteImageHandler(imageId: string, deleteToken: string): Promise<Response> {
    try {
        const metaEntry = await kv.get<ImageMeta>(["images", imageId, "meta"]);
        if (!metaEntry.value) {
            return new Response(JSON.stringify({ error: "Image not found" }), { status: 404, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });
        }
        if (metaEntry.value.deleteToken !== deleteToken) {
            return new Response(JSON.stringify({ error: "Unauthorized to delete" }), { status: 403, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });
        }

        const atomicOp = kv.atomic().delete(["images", imageId, "meta"]);
        if (metaEntry.value.md5) {
            atomicOp.delete(["md5_to_id", metaEntry.value.md5]);
        }
        for (let i = 0; i < metaEntry.value.chunks; i++) {
            atomicOp.delete(["images", imageId, "chunk", i]);
        }
        const res = await atomicOp.commit();
        if (!res.ok) throw new Error("KV Error: Failed to commit deletion.");

        cache.delete(imageId);
        return new Response(JSON.stringify({ message: "Image deleted successfully" }), { status: 200, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });
    } catch (error) {
        console.error(`Delete image error for ${imageId}:`, error);
        return new Response(JSON.stringify({ error: error.message || "Internal Server Error during deletion" }), { status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });
    }
}

async function listImagesHandler(request: Request): Promise<Response> {
    try {
        const images = [];
        const origin = new URL(request.url).origin;
        // Note: Iterating with prefix can be less performant on very large datasets
        // but is fine for typical free-tier usage.
        const iter = kv.list<ImageMeta>({ prefix: ["images"] });

        for await (const entry of iter) {
            if (entry.key.length === 3 && entry.key[2] === "meta") { // Ensure it's a meta entry
                const imageMeta = entry.value;
                if (imageMeta?.completed) { // Check if imageMeta and completed flag are valid
                    const imageId = entry.key[1] as string;
                    const fileExtension = imageMeta.name?.split('.').pop() || ''; // Add safe navigation for name
                    const imageUrl = `${origin}/image/${imageId}${fileExtension ? '.' + fileExtension : ''}`;
                    images.push({
                        id: imageId,
                        name: imageMeta.name || "Unnamed File",
                        url: imageUrl,
                        uploadedAt: imageMeta.uploadedAt || Date.now(),
                        deleteToken: imageMeta.deleteToken,
                    });
                }
            }
        }
        images.sort((a, b) => b.uploadedAt - a.uploadedAt);
        return new Response(JSON.stringify(images), { status: 200, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });
    } catch (error) {
        console.error("List images error:", error);
        return new Response(JSON.stringify({ error: "Internal Server Error while listing images" }), { status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders() } });
    }
}


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
    return serveImage(imageRouteMatch[1]);
  }

  const deleteRouteMatch = pathname.match(/^\/api\/image\/([0-9a-fA-F-]+)\/([0-9a-fA-F-]+)$/);
  if (request.method === "DELETE" && deleteRouteMatch) {
      return deleteImageHandler(deleteRouteMatch[1], deleteRouteMatch[2]);
  }

  if (request.method === "GET" && pathname === "/api/images") {
    return listImagesHandler(request);
  }

  if (pathname === "/" || pathname === "/index.html") {
    try {
        return await serveFile(request, new URL("./index.html", import.meta.url).pathname);
    } catch (e) {
        console.error("Error serving index.html:", e);
        return new Response(e instanceof Deno.errors.NotFound ? "index.html not found." : "Error serving file.", { status: e instanceof Deno.errors.NotFound ? 404 : 500 });
    }
  }

  return new Response("Not Found", { status: 404, headers: getCorsHeaders() });
}

console.log("Image server running on http://localhost:8000 (or Deno Deploy URL)");
serve(handler);
