/*
    Copyright 2026 Julien Javelaud

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
// -----------------------------------------------------------------------------------------------------------

// A signed URL a browser can CACHE — the rule behind
// StorageService.getCacheablePresignedUrl (the exercise library's
// thumbnails, Phase 7).
//
// The problem. A browser caches an image under its exact URL, query string
// included. A presigned URL's query string carries the moment it was signed
// (X-Amz-Date) and a signature computed from it, so signing the same file
// twice, a second apart, gives two DIFFERENT URLs — and the browser, seeing
// an address it has never fetched, downloads the photo again. The library
// list is refetched often (TanStack Query refetches stale data when the
// window regains focus), so every card's photo would be downloaded again
// and again.
//
// The fix. Sign with a moment ROUNDED DOWN to the start of a fixed window
// (the hour) instead of "now". Signing is a pure computation — an HMAC over
// the request's description, the credentials and the signing date — so the
// same file signed with the same rounded moment gives the SAME URL, byte
// for byte, for the whole hour, and the browser reuses its copy. A new hour
// gives a new URL, and one download per photo per hour.
//
// Two numbers follow from rounding down:
//   - the URL must stay valid for at least a full window after it is handed
//     out. Signed at 14:00 (rounded) but handed out at 14:59, a 1-hour
//     lifetime would leave one minute. So the lifetime is TWO windows: the
//     URL handed out at any moment of the 14:00 window lives until 16:00, at
//     least an hour later.
//   - the browser must be TOLD it may keep the image. Storage answers with
//     whatever Cache-Control the signed URL asks for (S3's
//     response-cache-control parameter, which only a signed request may
//     use, so nobody can change it without breaking the signature).
//     `private`: the browser only, no shared cache (a proxy, a CDN) —
//     nothing in Stride's storage should be cached for other people.
//     `max-age` = one window: within it the URL can't change, so the copy
//     stays the right one; after it, the list hands out a new URL anyway.
//
// Why reusing a copy is safe: a stored file's content never changes under
// its key — a new photo is a new key (the library's uploads are named
// upload-<time>-<n>; nothing in the app writes over an existing key), and
// "a different cover" is a different key at position 0, so a different URL.

// One hour. Longer would mean fewer downloads, but also a longer life for
// a URL that leaks (copied into a message, say): two windows.
export const CACHEABLE_URL_WINDOW_SECONDS = 60 * 60

export interface CacheableSigning {
  // The moment the signature claims — the start of now's window.
  signingDate: Date
  // How long the URL is valid after signingDate, in seconds (two windows).
  expiresIn: number
  // The Cache-Control header storage is asked to answer with.
  cacheControl: string
}

export function cacheableSigning(now: Date): CacheableSigning {
  const windowMs = CACHEABLE_URL_WINDOW_SECONDS * 1000
  // Math.floor on the milliseconds since 1970 (UTC): every moment from
  // 14:00:00.000 to 14:59:59.999 lands on 14:00:00.000 — the same for every
  // backend instance, whatever its time zone.
  const signingDate = new Date(Math.floor(now.getTime() / windowMs) * windowMs)
  return {
    signingDate,
    expiresIn: 2 * CACHEABLE_URL_WINDOW_SECONDS,
    cacheControl: `private, max-age=${CACHEABLE_URL_WINDOW_SECONDS}`,
  }
}
