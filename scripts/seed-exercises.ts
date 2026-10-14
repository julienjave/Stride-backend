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

import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { AppModule } from '../src/app.module'
import { StorageService } from '../src/storage/storage.service'
import { exercises } from '../src/database/schema'
import { getDatabaseUrl } from '../src/config/database-url'
import * as schema from '../src/database/schema'
import { cleanInstructions } from './seed/exercise-import'

const SOURCE_JSON_URL =
  'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json'
const IMAGE_BASE_URL =
  'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/'

// The shape of one entry in the source dataset
interface SourceExercise {
  id: string
  name: string
  equipment: string | null
  primaryMuscles: string[]
  secondaryMuscles: string[]
  instructions: string[]
  images: string[]
}

async function run() {
  console.log('Booting Nest application context (no HTTP server)...')
  const app = await NestFactory.createApplicationContext(AppModule)
  // Owner connection, not the app's restricted DRIZZLE token — this is a
  // privileged, one-time operational script (not a real application
  // request), and exercises has FORCE ROW LEVEL SECURITY with an INSERT
  // policy that requires session context this script never sets. Same
  // pattern as scripts/create-app-role.ts.
  const ownerPool = new Pool({ connectionString: getDatabaseUrl() })
  const db = drizzle(ownerPool, { schema })
  const storage = app.get(StorageService)

  console.log(`Fetching ${SOURCE_JSON_URL} ...`)
  const response = await fetch(SOURCE_JSON_URL)
  if (!response.ok) {
    throw new Error(`Failed to fetch source dataset: HTTP ${response.status}`)
  }
  const sourceExercises: SourceExercise[] = await response.json()
  console.log(`Fetched ${sourceExercises.length} exercises from the source dataset.`)

  let imported = 0
  let skipped = 0

  for (const entry of sourceExercises) {
    // Idempotent: running this script twice should never create duplicates —
    // relies on the same partial unique index on external_id we added to the
    // schema specifically for this. Safe to re-run if it's interrupted partway.
    const existing = await db.query.exercises.findFirst({
      where: eq(exercises.externalId, entry.id),
    })
    if (existing) {
      skipped++
      continue
    }

    // Download each image from the source and re-upload it into OUR OWN
    // MinIO bucket — never storing the source GitHub URL directly. This is
    // the "import once, own a local copy forever" decision from when we
    // picked this dataset: no live dependency on GitHub's raw CDN at runtime.
    const mediaUrls: string[] = []
    for (const [index, imagePath] of entry.images.entries()) {
      const imageResponse = await fetch(`${IMAGE_BASE_URL}${imagePath}`)
      if (!imageResponse.ok) {
        console.warn(`  Skipping missing image: ${imagePath}`)
        continue
      }
      const buffer = Buffer.from(await imageResponse.arrayBuffer())
      const objectKey = `exercises/${entry.id}/${index}.jpg`
      await storage.upload(objectKey, buffer, 'image/jpeg')
      mediaUrls.push(objectKey)
    }

    await db.insert(exercises).values({
      externalId: entry.id,
      name: entry.name,
      primaryMuscles: entry.primaryMuscles ?? [],
      secondaryMuscles: entry.secondaryMuscles ?? [],
      // The source stores equipment as a single string (or null); our schema
      // stores an array, matching the "equipment" column pattern from
      // template_exercises — a single-item array here, not a mismatch.
      equipment: entry.equipment ? [entry.equipment] : [],
      // An array, like the source's own shape (instructions is a TEXT[]
      // column), no formatting or numbering baked in — that's a frontend
      // rendering decision. Cleaned on the way in (trimmed, blank steps
      // dropped — cleanInstructions): the app refuses blank steps, so the
      // library mustn't start with any.
      instructions: cleanInstructions(entry.instructions),
      mediaUrls,
      source: 'api',
    })

    imported++
    if (imported % 50 === 0) {
      console.log(`  ...${imported} imported so far`)
    }
  }

  console.log(`Done. Imported ${imported}, skipped ${skipped} (already present).`)
  await ownerPool.end()
  await app.close()
}

run().catch((err) => {
  console.error('Seed script failed:', err)
  process.exit(1)
})