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

import { BadRequestException } from '@nestjs/common'
import { memoryStorage } from 'multer'
import type { Request } from 'express'


// --- MAIN LOGIC --------------------------------------------------------------------------------------------

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp']

// Shared Multer configuration for every image-upload route (avatars, clinic
// logos, exercise images)
export const imageUploadOptions = {
  // Buffers held in memory only, never written to local disk — we
  // immediately re-upload each file's bytes to our own object storage
  // (RustFS) via StorageService, so touching the filesystem in between
  // would be pure overhead with nothing gained.
  storage: memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB per file
  },
  // fileFilter runs BEFORE a file is fully accepted — rejecting here means
  // Multer never even finishes buffering a disallowed file type.
  fileFilter: (
    _req: Request,
    file: Express.Multer.File,
    callback: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      callback(new BadRequestException('Only JPEG, PNG, and WebP images are allowed'), false)
      return
    }
    callback(null, true)
  },
}

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

// A sensible file extension for the object key, derived from the actual
// verified mime type — not trusted from the client's original filename,
// which could say anything regardless of the file's real content.
export function extensionForMimeType(mimeType: string): string {
  return EXTENSION_BY_MIME_TYPE[mimeType] ?? 'bin'
}