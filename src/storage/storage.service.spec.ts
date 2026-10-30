import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Logger } from '@nestjs/common'
import {
  CopyObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { StorageService, storageClientConfig } from './storage.service'

// Only deleteUnreferenced() is tested here — the other methods are thin
// wrappers around the AWS SDK, exercised for real by the e2e tests
// against RustFS. Constructing the service is safe without a storage
// server: the constructor only builds an S3Client object; nothing
// connects until a command is sent (onModuleInit isn't called here).
describe('StorageService.deleteUnreferenced', () => {
  let storageService: StorageService
  let deleteSpy: jest.SpyInstance<Promise<void>, [string]>
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    storageService = new StorageService()
    // Replaces the real delete() (which would call RustFS) on this one
    // instance, so each test decides whether storage "succeeds" or "fails".
    deleteSpy = jest.spyOn(storageService, 'delete')
    // Logger.prototype: the service's own logger is a private
    // `new Logger(...)`, so the spy goes on the class every logger shares.
    // mockImplementation(() => {}) also keeps the test output clean.
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('deletes the object through delete()', async () => {
    deleteSpy.mockResolvedValue(undefined)

    await storageService.deleteUnreferenced('avatars/5/old.png')

    expect(deleteSpy).toHaveBeenCalledWith('avatars/5/old.png')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does NOT throw when storage fails — it logs a warning naming the key instead', async () => {
    deleteSpy.mockRejectedValue(new Error('connect ECONNREFUSED'))

    // resolves.toBeUndefined(): the returned Promise succeeds, which is the
    // whole point — the caller's already-saved change isn't turned into
    // an error.
    await expect(
      storageService.deleteUnreferenced('avatars/5/old.png'),
    ).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('avatars/5/old.png'),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('connect ECONNREFUSED'),
    )
  })
})

// copy(): the request it sends — the real copy against an S3 server is
// proven end to end by test/program-exercise-photos.e2e-spec.ts (moto).
// The spy goes on S3Client.prototype.send: the service's client is a
// private field, but every S3Client shares its prototype's send().
describe('StorageService.copy', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('sends ONE CopyObject: the destination key, and the bucket-prefixed source, each path segment encoded', async () => {
    // `as never`: send() is overloaded (a promise, or a callback); the
    // mock only needs to resolve, whatever the overload's result type.
    const send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never)

    const key = await new StorageService().copy(
      'exercises/12/front view é.jpg',
      'patients/5/exercise-photos/new.jpg',
    )

    expect(key).toBe('patients/5/exercise-photos/new.jpg')
    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0][0] as unknown
    expect(command).toBeInstanceOf(CopyObjectCommand)
    // toStrictEqual: no other field (a MetadataDirective of REPLACE would
    // drop the Content-Type).
    expect((command as CopyObjectCommand).input).toStrictEqual({
      Bucket: 'stride',
      Key: 'patients/5/exercise-photos/new.jpg',
      CopySource: 'stride/exercises/12/front%20view%20%C3%A9.jpg',
    })
  })

  it('lets a storage failure reach the caller (it must undo its own work)', async () => {
    jest
      .spyOn(S3Client.prototype, 'send')
      .mockRejectedValue(new Error('NoSuchKey') as never)

    await expect(
      new StorageService().copy('exercises/1/a.png', 'patients/1/b.png'),
    ).rejects.toThrow('NoSuchKey')
  })
})

// How the client TALKS to the storage server — checked against a real HTTP
// server started by the test on a free local port, because what matters here
// (a header on the wire, a request abandoned in time) only exists on a real
// socket: a mocked send() would never show it.
describe('the storage client, on the wire', () => {
  let server: Server
  // What the fake storage server received: the headers, and how many body
  // bytes arrived.
  let received: { headers: IncomingHttpHeaders; bodyBytes: number }[]
  // Whether the server answers at all: false plays a storage server that
  // accepts the request and then never responds.
  let answers: boolean
  const savedEnv = { ...process.env }

  beforeEach(async () => {
    received = []
    answers = true
    server = createServer((request, response) => {
      const entry = { headers: request.headers, bodyBytes: 0 }
      received.push(entry)
      request.on('data', (chunk: Buffer) => {
        entry.bodyBytes += chunk.length
      })
      // Answers once the WHOLE body has arrived, as S3 does for a PUT. It
      // never answers "100 Continue": a client that asked for it waits.
      request.on('end', () => {
        if (answers) response.writeHead(200, { ETag: '"x"' }).end()
      })
    })
    // Port 0: the system picks a free one.
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    process.env.STORAGE_ENDPOINT = '127.0.0.1'
    process.env.STORAGE_PORT = String((server.address() as AddressInfo).port)
  })

  afterEach(async () => {
    process.env = { ...savedEnv }
    // closeAllConnections: a request the server never answered would
    // otherwise keep close() waiting.
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  // 3 MB: over the SDK's 2 MB threshold for "Expect: 100-continue", like
  // any phone photo. With the header, this server (which never says "100
  // Continue") would get the body only after Node's 6 s wait — the
  // "uploading takes forever" bug.
  it('sends a big upload in one go: no "Expect: 100-continue", the whole body at once', async () => {
    const started = Date.now()

    await new StorageService().upload(
      'patients/5/exercise-photos/big.jpg',
      Buffer.alloc(3 * 1024 * 1024),
      'image/jpeg',
    )

    expect(received).toHaveLength(1)
    expect(received[0].headers.expect).toBeUndefined()
    expect(received[0].bodyBytes).toBe(3 * 1024 * 1024)
    // Far below the 6 s a wait for "100 Continue" costs.
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  // A server that never answers: the call FAILS after requestTimeout instead
  // of waiting forever. The same configuration as the service's, with a
  // short timeout so the test doesn't wait 30 s.
  it('abandons a call the server never answers, with a TimeoutError', async () => {
    answers = false
    const client = new S3Client(
      storageClientConfig({ connectionTimeout: 1_000, requestTimeout: 300 }),
    )
    const started = Date.now()

    await expect(
      client.send(
        new PutObjectCommand({ Bucket: 'stride', Key: 'k.png', Body: 'x' }),
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    // It did reach the server (the timeout is the request's, not the
    // connection's), and gave up soon after 300 ms, not at the test's own
    // 5 s limit. maxAttempts 1 isn't set: the SDK retries a timeout (3
    // attempts by default), hence "under 2 s" rather than "about 300 ms".
    expect(received.length).toBeGreaterThanOrEqual(1)
    expect(Date.now() - started).toBeLessThan(2_000)
    client.destroy()
  })
})

// listObjects(): the PAGING — an S3 server answers at most 1,000 keys a
// request; the real listing against an S3 server is in
// test/storage-sweep.e2e-spec.ts (moto). The spy answers two pages.
describe('StorageService.listObjects', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('reads every page, sending back the continuation token, and yields each object in order', async () => {
    const first = new Date('2031-01-01T00:00:00Z')
    const second = new Date('2031-01-02T00:00:00Z')
    const send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'avatars/1/a.png', LastModified: first, Size: 10 },
          // Never happens with a real server; skipped, never guessed.
          { Key: undefined, LastModified: first, Size: 1 },
        ],
        IsTruncated: true,
        NextContinuationToken: 'page-2',
      } as never)
      .mockResolvedValueOnce({
        Contents: [{ Key: 'avatars/2/b.png', LastModified: second }],
        IsTruncated: false,
      } as never)

    const listed: unknown[] = []
    for await (const object of new StorageService().listObjects('avatars/')) {
      listed.push(object)
    }

    expect(listed).toEqual([
      { key: 'avatars/1/a.png', lastModified: first, size: 10 },
      // No Size in the answer: 0.
      { key: 'avatars/2/b.png', lastModified: second, size: 0 },
    ])
    const inputs = send.mock.calls.map(([command]) => {
      expect(command).toBeInstanceOf(ListObjectsV2Command)
      return (command as ListObjectsV2Command).input
    })
    expect(inputs).toEqual([
      { Bucket: 'stride', Prefix: 'avatars/', ContinuationToken: undefined },
      { Bucket: 'stride', Prefix: 'avatars/', ContinuationToken: 'page-2' },
    ])
  })

  // An empty folder: one request, nothing yielded (Contents is absent).
  it('yields nothing for an empty prefix', async () => {
    const send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValueOnce({ IsTruncated: false } as never)

    const listed: unknown[] = []
    for await (const object of new StorageService().listObjects('clinics/')) {
      listed.push(object)
    }

    expect(listed).toEqual([])
    expect(send).toHaveBeenCalledTimes(1)
  })
})

// Signing is a pure computation (an HMAC over the request and the signing
// date, with the credentials) — no storage server is contacted, so the REAL
// method is tested here, with the real SDK, and the URLs read back.
describe('StorageService.getCacheablePresignedUrl', () => {
  const storageService = new StorageService()
  const sign = (key: string, moment: string) =>
    storageService.getCacheablePresignedUrl(key, new Date(moment))

  it('gives the SAME URL, byte for byte, for any two moments of one hour', async () => {
    const early = await sign('exercises/7/0.jpg', '2031-03-04T14:00:01.000Z')
    const late = await sign('exercises/7/0.jpg', '2031-03-04T14:59:59.999Z')

    expect(late).toBe(early)
  })

  it('gives a new URL in the next hour', async () => {
    const before = await sign('exercises/7/0.jpg', '2031-03-04T14:59:59.999Z')
    const after = await sign('exercises/7/0.jpg', '2031-03-04T15:00:00.000Z')

    expect(after).not.toBe(before)
  })

  it('signs at the hour, for two hours, asking for a one-hour browser cache', async () => {
    const url = new URL(
      await sign('exercises/7/0.jpg', '2031-03-04T14:27:13.000Z'),
    )

    // The file's own address (path-style, the bucket first)...
    expect(url.pathname).toBe('/stride/exercises/7/0.jpg')
    // ...and the signature's parameters: SigV4's date format is
    // YYYYMMDD'T'HHMMSS'Z', UTC.
    expect(url.searchParams.get('X-Amz-Date')).toBe('20310304T140000Z')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('7200')
    expect(url.searchParams.get('response-cache-control')).toBe(
      'private, max-age=3600',
    )
  })

  it('gives each file its own URL', async () => {
    const first = await sign('exercises/7/0.jpg', '2031-03-04T14:10:00.000Z')
    const second = await sign('exercises/7/1.jpg', '2031-03-04T14:10:00.000Z')

    expect(second).not.toBe(first)
  })
})
