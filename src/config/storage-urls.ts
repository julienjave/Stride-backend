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

// --- TWO ADDRESSES FOR ONE STORAGE SERVER ------------------------------------------------------------------
//
// The API reaches RustFS in two different ways, and they need two different
// addresses:
//
//   - the INTERNAL address: where the backend itself sends its uploads,
//     copies, deletes and listings. In production that's `storage:9000` — the
//     Compose service's name, which only containers on the same Docker
//     network can resolve. Locally, `localhost:9000`.
//   - the PUBLIC address: what goes into the presigned URLs the API hands to
//     browsers, so a browser can download a photo straight from storage. In
//     production, `https://files.stridecare.app` — a site in the Caddyfile
//     that forwards to `storage:9000`.
//
// Why the public address can't just be swapped into a URL after signing: a
// presigned URL carries a SIGNATURE (AWS Signature Version 4), computed over
// the request it allows — the method, the PATH, the HOST header, the query
// parameters, the expiry. When the browser makes that request, RustFS
// recomputes the signature from what it received and refuses any mismatch.
// Change the host afterwards and the signature no longer matches; so the
// URL must be SIGNED for the address the browser will use. That's why
// StorageService has a second S3 client, configured with this public
// address, used only for signing (signing is offline: that client never
// connects to anything).
//
// It's also why the public address is a HOST of its own and not a path on
// the API's (`api.stridecare.app/files/...`): the path is signed too, and a
// proxy stripping `/files` before RustFS would change it.
//
// STORAGE_PUBLIC_URL, optional outside production:
//   - unset (local development, the e2e suites, the scripts): the public
//     address IS the internal one. `http://localhost:9000` is reachable by a
//     browser on the same machine, so nothing changes from before.
//   - REQUIRED when NODE_ENV=production: there, the internal address is a
//     name no browser can resolve, so every photo would be broken. Better
//     refused at start than discovered on the first page with a picture.
//   - an ORIGIN only — scheme, host, optional port; no path, no query, no
//     user name or password. A path would become part of every signed path,
//     and RustFS doesn't serve the bucket under a prefix.
//   - `https://` in production: the frontend is served over https, and a
//     browser blocks an `http://` image on an https page ("mixed content").
//
// Read where it's needed, like the other settings (validateEnv() at start,
// StorageService when it's built), so ONE function holds the rules.

// --- INTERNAL ----------------------------------------------------------------------------------------------

// What the backend's own S3 calls go to. Plain http: the traffic never leaves
// the machine (the Compose network, or localhost).
export function storageInternalEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `http://${env.STORAGE_ENDPOINT ?? 'localhost'}:${env.STORAGE_PORT ?? 9000}`
}

// --- PUBLIC ------------------------------------------------------------------------------------------------

// What presigned URLs are signed for — the address browsers use. Throws, with
// a message naming the setting, when the value breaks a rule above.
export function storagePublicEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string {
  // An empty value counts as absent (a line left as `STORAGE_PUBLIC_URL=` in
  // .env).
  const value = env.STORAGE_PUBLIC_URL?.trim() || null
  const production = env.NODE_ENV === 'production'

  if (value === null) {
    if (production) {
      throw new Error(
        'Missing required environment variable: STORAGE_PUBLIC_URL. In ' +
          "production, browsers can't reach storage at its internal address " +
          `(${storageInternalEndpoint(env)}): set the public https:// address ` +
          'that Caddy forwards to storage, e.g. https://files.stridecare.app.',
      )
    }
    return storageInternalEndpoint(env)
  }

  // `new URL` throws on anything that isn't an absolute URL ("files.x.app"
  // without a scheme, a typo with a space) — turned into OUR message.
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(
      `STORAGE_PUBLIC_URL must be an absolute address such as https://files.stridecare.app — got "${value}".`,
    )
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(
      `STORAGE_PUBLIC_URL must start with https:// (or http:// outside production) — got "${value}".`,
    )
  }
  if (production && url.protocol !== 'https:') {
    throw new Error(
      `STORAGE_PUBLIC_URL must be an https:// address in production: browsers block http:// images on an https page — got "${value}".`,
    )
  }
  // `pathname` is "/" for a bare origin, with or without the trailing slash
  // ("https://x.app" and "https://x.app/" both parse to "/").
  if (
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error(
      `STORAGE_PUBLIC_URL must be just a scheme and a host (and a port, if needed), with no path, query or credentials — got "${value}".`,
    )
  }

  // `origin` is the normalised form: lowercase host, no trailing slash, and
  // no port when it is the scheme's default ("https://x.app:443" →
  // "https://x.app"). It's what the S3 client expects as its endpoint.
  return url.origin
}
