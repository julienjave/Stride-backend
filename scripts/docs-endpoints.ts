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

// npm run docs:endpoints — rewrites the generated table in
// docs/api/06-endpoints.md from the controllers' own decorators.
//
// Run it after adding, removing or changing a route: the unit tests
// (scripts/docs/endpoints.spec.ts) fail until the table matches the code
// again. Everything it decides is in scripts/docs/endpoints.ts. It needs no
// database and no .env: it loads the controller classes, it doesn't start
// the app.

import 'reflect-metadata'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appRoutes,
  appTable,
  ENDPOINTS_DOC,
  wiringProblems,
  withGeneratedPart,
} from './docs/endpoints'

const ROOT = join(__dirname, '..')

// `require`, not `import()`: ts-node runs this file as CommonJS, where
// require() loads a .ts file synchronously through ts-node's own hook.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadModule = (file: string) => require(file) as Record<string, unknown>
const routes = appRoutes(ROOT, loadModule)

// A guard wired wrongly would make the "Who" column wrong — refuse to write
// a table that misstates who may call a route.
const problems = wiringProblems(routes)
if (problems.length > 0) {
  console.error(
    'Not written — these routes are wired in a way the table would misstate:',
  )
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

const path = join(ROOT, ENDPOINTS_DOC)
const before = readFileSync(path, 'utf8')
const after = withGeneratedPart(before, appTable(routes))
if (after === before) {
  console.log(
    `${ENDPOINTS_DOC} is already up to date (${routes.length} routes).`,
  )
} else {
  writeFileSync(path, after)
  console.log(`${ENDPOINTS_DOC} updated (${routes.length} routes).`)
}
