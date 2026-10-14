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
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

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

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name)
  private readonly client: S3Client
  private readonly bucket = 'stride'

  constructor() {
    this.client = new S3Client({
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
    })
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
  // what makes the leftover file findable later (a periodic cleanup of
  // unreferenced keys is noted in deferred-improvements.md).
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
