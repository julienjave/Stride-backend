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

import type { Server } from 'node:http'
import { Controller, Get, Header, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { corsOptions } from './cors-options'

// The settings run in a REAL Nest app, through the same `enableCors` main.ts
// calls — what a browser receives, not what an object literal contains. One
// route answers like the records export: a file name in Content-Disposition.

@Controller()
class FileController {
  @Get('file')
  @Header('Content-Disposition', 'attachment; filename="copy.pdf"')
  file() {
    return 'pdf'
  }
}

describe('corsOptions', () => {
  let app: INestApplication
  const previousOrigins = process.env.FRONTEND_URLS

  beforeAll(async () => {
    process.env.FRONTEND_URLS = 'http://app.test, http://staging.test'
    const moduleRef = await Test.createTestingModule({
      controllers: [FileController],
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    app.enableCors(corsOptions())
    await app.init()
  })

  // Nest types the server `any`; under Express it is Node's http.Server.
  const server = () => app.getHttpServer() as Server

  afterAll(async () => {
    await app.close()
    if (previousOrigins === undefined) delete process.env.FRONTEND_URLS
    else process.env.FRONTEND_URLS = previousOrigins
  })

  // The point of the change (decisions §20, pass 3): without these two in
  // Access-Control-Expose-Headers, the page's `headers.get('Content-
  // Disposition')` answers null, and a 429's Retry-After too.
  it('lets an allowed frontend read the file name and Retry-After', async () => {
    const response = await request(server())
      .get('/file')
      .set('Origin', 'http://staging.test')
      .expect(200)
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://staging.test',
    )
    expect(response.headers['access-control-allow-credentials']).toBe('true')
    expect(response.headers['access-control-expose-headers']).toBe(
      'Content-Disposition,Retry-After',
    )
  })

  // The neighbour: the headers exposed don't widen WHO may read the API.
  // Another site gets no Access-Control-Allow-Origin, and without it the
  // browser refuses the whole answer to that page — whatever else is sent
  // (the cors middleware still adds Allow-Credentials; measured, harmless
  // alone).
  it('gives a site that is not a configured frontend no access', async () => {
    const response = await request(server())
      .get('/file')
      .set('Origin', 'http://elsewhere.test')
      .expect(200)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})
