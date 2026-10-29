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

// --- IMPORTS -----------------------------------------------------------------------------------------------

import {
  Injectable,
  OnModuleInit,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common'
import {
  S3Client,
  type S3ClientConfig,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  CopyObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// One object as the storage server lists it (listObjects below).
export interface StoredObject {
  key: string
  lastModified: Date
  size: number
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// A generic safety ceiling for ANY upload through this service, regardless
// of caller — deliberately a DIFFERENT number from the 5MB limit
// image-upload.config.ts enforces at the route level (not a duplicate of
// that specific business rule, a different kind of check entirely). The
// route-level Multer limit answers "is this appropriate for a profile
// photo"; this answers "is this an absurd upload no matter what it's for."
// Relying on Multer's config alone means this guard only exists for
// callers that happen to go through a Multer-configured route — if
// StorageService.upload() is ever called from anywhere else in the future,
// that caller would currently have ZERO size enforcement at all.
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024 // 10MB

// How long a call to the storage server may take before it is abandoned,
// in milliseconds. Without these, the SDK waits FOREVER: a storage server
// that accepts a connection and never answers would keep the HTTP request
// that triggered the call (an upload, say) open with it, and the browser
// would show "Uploading…" for good.
//   - connectionTimeout: opening the connection. Storage runs next to the
//     backend (same machine, same Docker network): if it can't connect in
//     5 s, it's down, and waiting longer won't change that.
//   - requestTimeout: the whole exchange, sending the body included. A 5 MB
//     photo crosses a local network in well under a second; 30 s leaves a
//     wide margin for a slow disk or a busy server, while still turning a
//     server that never answers into an ERROR the caller can handle — the
//     program-photo upload, for one, then deletes the files it already
//     stored (its compensating action) and answers a 500.
export const STORAGE_TIMEOUTS = {
  connectionTimeout: 5_000,
  requestTimeout: 30_000,
}

// The S3 client's configuration, apart from the class so a test can build a
// client with the SAME settings but shorter timeouts (waiting 30 s in a unit
// test would be absurd).
export function storageClientConfig(
  timeouts: typeof STORAGE_TIMEOUTS = STORAGE_TIMEOUTS,
): S3ClientConfig {
  return {
    endpoint: `http://${process.env.STORAGE_ENDPOINT ?? 'localhost'}:${process.env.STORAGE_PORT ?? 9000}`,
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.RUSTFS_ACCESS_KEY ?? 'rustfsadmin',
      secretAccessKey: process.env.RUSTFS_SECRET_KEY ?? 'rustfsadmin',
    },
    // AWS S3 addresses buckets via subdomains (bucket.s3.amazonaws.com),
    // relying on AWS's own wildcard DNS. Self-hosted S3-compatible servers
    // don't have that DNS setup, so they address buckets via the URL PATH
    // instead (localhost:9000/stride/...). forcePathStyle is what tells the
    // SDK to use that addressing style — required for any self-hosted target.
    forcePathStyle: true,
    // By default the SDK adds "Expect: 100-continue" to every request whose
    // body is 2 MB or more: it sends only the HEADERS, and waits for the
    // server to answer "100 Continue" before sending the body — so a server
    // that would refuse the request (bad credentials, no such bucket) can do
    // it before megabytes cross the network. If the server doesn't send
    // that "100 Continue", Node waits a fixed 6 SECONDS and then sends the
    // body anyway. Every phone photo is over 2 MB: 6 s each, one after the
    // other — 30 s for five photos, a page that looks stuck.
    // The saving is worthless here: storage is on the local network, and
    // the backend already checked everything (size, type, permissions)
    // before calling it. So: always send the body straight away.
    expectContinueHeader: false,
    // The SDK's HTTP layer (NodeHttpHandler) takes the timeouts.
    // throwOnRequestTimeout: without it, an exceeded requestTimeout is only
    // logged as a warning and the call keeps waiting (the option was, for
    // years, a socket IDLE timeout, so making it an error is opt-in).
    requestHandler: {
      connectionTimeout: timeouts.connectionTimeout,
      requestTimeout: timeouts.requestTimeout,
      throwOnRequestTimeout: true,
    },
  }
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name)
  private readonly client: S3Client
  private readonly bucket = 'stride'

  constructor() {
    this.client = new S3Client(storageClientConfig())
  }

  async onModuleInit() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }))
      this.logger.log(`Created bucket "${this.bucket}"`)
    }
  }

  // === ROUTES =============================================================

  // --- POST ROUTES ---

  // Uploads a file, returns the object key
  async upload(
    objectKey: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    // Checked first, before any network call — no reason to spend a round
    // trip to RustFS on a payload we're going to reject anyway.
    if (buffer.byteLength > MAX_UPLOAD_SIZE_BYTES) {
      throw new PayloadTooLargeException(
        `File exceeds the maximum allowed size of ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB`,
      )
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: buffer,
        ContentType: contentType,
      }),
    )
    return objectKey
  }

  // Copies an object to a new key INSIDE storage — S3's CopyObject: the
  // storage server duplicates the bytes itself, so they never travel through
  // this backend (no download, no re-upload, no buffer in memory). Used for
  // a program exercise's own photos: copying the library's photos into a
  // patient's set, and "Assign again" copying a program's photos to the new
  // program. Each program then owns its files outright — removing one
  // never affects the other, and no file is shared between rows (nothing to
  // reference-count before deleting).
  //
  // CopySource is "<bucket>/<key>", URL-encoded — the S3 API carries it in a
  // request HEADER (x-amz-copy-source), where a space or a non-ASCII
  // character must be percent-encoded. Each path SEGMENT is encoded on its
  // own, so the "/" between folders stays a "/". The keys this app builds
  // are plain ASCII today; the encoding keeps a library key from an import
  // (any file name) from breaking the copy.
  //
  // The object's metadata, its Content-Type included, is copied with it
  // (MetadataDirective defaults to COPY), so the copy is served as the same
  // kind of image. No size check like upload()'s: the source was already
  // stored through upload(), under its limit.
  async copy(sourceKey: string, destinationKey: string): Promise<string> {
    const encodedSource = sourceKey
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destinationKey,
        CopySource: `${this.bucket}/${encodedSource}`,
      }),
    )
    return destinationKey
  }

  // --- GET ROUTES ---

  // Generates a temporary, signed URL good for `expirySeconds` — presigned-URL
  // pattern letting a browser fetch the file directly without
  // routing the bytes through our NestJS server.
  async getPresignedUrl(
    objectKey: string,
    expirySeconds = 900,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    })
    return getSignedUrl(this.client, command, { expiresIn: expirySeconds })
  }

  // Same as getPresignedUrl above, but safe to call with a possibly-absent
  // key. Every image-bearing resource (clinic logos, user avatars, exercise
  // photos) stores its object key as `string | null` — "no file uploaded
  // yet" is a completely normal state, not an error. Without this helper,
  // every single caller would need to repeat the same
  // `key ? await getPresignedUrl(key) : null` ternary; centralizing it here
  // means that null-handling logic (and anything it might need later, like
  // error handling around a bad key) only has one place to change.
  async getPresignedUrlOrNull(
    objectKey: string | null,
    expirySeconds = 900,
  ): Promise<string | null> {
    if (!objectKey) return null
    return this.getPresignedUrl(objectKey, expirySeconds)
  }

  // --- LISTING ---

  // Every object whose key starts with `prefix`, with when it was last
  // written — for the storage sweeper (scripts/storage-sweep.ts), which
  // compares them with the keys the database references. Nothing in the app
  // itself lists storage: every file is reached through its row.
  //
  // S3's ListObjectsV2 answers at most 1,000 keys per request. When there
  // are more, the answer says IsTruncated and gives a NextContinuationToken;
  // sending it back asks for the next page. An ASYNC GENERATOR (`async *`,
  // `yield`) hands the objects to the caller one by one, fetching the next
  // page only when the caller gets there — `for await (const o of
  // storage.listObjects('avatars/'))` — so the whole bucket never has to be
  // in memory at once, and the paging stays hidden in here.
  async *listObjects(prefix: string): AsyncGenerator<StoredObject> {
    let continuationToken: string | undefined
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      )
      for (const object of page.Contents ?? []) {
        // The SDK types every field as optional; a listed object always has
        // a key and a date, so one without them is skipped, never guessed.
        if (object.Key === undefined || object.LastModified === undefined) {
          continue
        }
        yield {
          key: object.Key,
          lastModified: object.LastModified,
          size: object.Size ?? 0,
        }
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined
    } while (continuationToken !== undefined)
  }

  // --- DELETE ROUTES ---

  // Actually frees the bytes in storage — deleting a row's reference to an
  // object key without this would just hide the waste, not eliminate it.
  async delete(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    )
  }

  // Best-effort cleanup of a file the database NO LONGER points at — call
  // it only AFTER the row that referenced the key has been updated.
  //
  // Why swallow the error instead of letting it propagate: at this point
  // the user's change (a new avatar, a removed logo, a removed exercise
  // photo) is already saved. If the storage server hiccups now, the only
  // thing left undone is freeing some bytes. Throwing would turn a
  // SUCCESSFUL change into a 500, the person would see "something went
  // wrong" and likely retry an action that already worked. An orphaned
  // file costs a little disk space and nothing else; nothing links to it.
  //
  // It's still logged, not silently ignored: a warning naming the key is
  // what makes the leftover file findable later — and the storage sweeper
  // (npm run storage:sweep) collects it.
  //
  // Lives HERE, not in each service: avatars, clinic logos and exercise
  // photos all need exactly this, and one definition means one place that
  // decides what "best effort" means.
  async deleteUnreferenced(objectKey: string): Promise<void> {
    try {
      await this.delete(objectKey)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.warn(
        `Could not delete unreferenced object "${objectKey}"; it is left orphaned in storage: ${reason}`,
      )
    }
  }
}
