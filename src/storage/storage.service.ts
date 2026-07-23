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

import { Injectable, OnModuleInit, Logger } from '@nestjs/common'
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'


// --- SERVICE -----------------------------------------------------------------------------------------------

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

  // Uploads a file, returns the object key
  async upload(objectKey: string, buffer: Buffer, contentType: string): Promise<string> {
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

  // Generates a temporary, signed URL good for `expirySeconds` — presigned-URL
  // pattern letting a browser fetch the file directly without
  // routing the bytes through our NestJS server.
  async getPresignedUrl(objectKey: string, expirySeconds = 900): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: objectKey })
    return getSignedUrl(this.client, command, { expiresIn: expirySeconds })
  }
}