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


import { Injectable, OnModuleInit, Logger } from '@nestjs/common'
import { Client } from 'minio'

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name)
  private readonly client: Client

  // One shared bucket for the whole app, organized by key prefix (folder-like paths
  // such as "avatars/42.jpg", "exercises/pushup-0.jpg") rather than a separate bucket
  // per feature — fewer buckets to create and manage permissions for.
  private readonly bucket = 'stride'

  constructor() {
    this.client = new Client({
      endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
      port: Number(process.env.MINIO_PORT ?? 9000),
      useSSL: false,
      accessKey: process.env.MINIO_ROOT_USER ?? 'minioadmin',
      secretKey: process.env.MINIO_ROOT_PASSWORD ?? 'minioadmin',
    })
  }

  async onModuleInit() {
    const exists = await this.client.bucketExists(this.bucket).catch(() => false)
    if (!exists) {
      await this.client.makeBucket(this.bucket)
      this.logger.log(`Created MinIO bucket "${this.bucket}"`)
    }
  }

  // Uploads a file, returns the object key
  async upload(objectKey: string, buffer: Buffer, contentType: string): Promise<string> {
    await this.client.putObject(this.bucket, objectKey, buffer, buffer.length, {
      'Content-Type': contentType,
    })
    return objectKey
  }

  // Generates a temporary, signed URL good for `expirySeconds` — presigned-URL
  // pattern letting a browser fetch the file directly without
  // routing the bytes through our NestJS server.
  async getPresignedUrl(objectKey: string, expirySeconds = 900): Promise<string> {
    return this.client.presignedGetObject(this.bucket, objectKey, expirySeconds)
  }
}