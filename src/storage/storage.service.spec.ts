import { Logger } from '@nestjs/common'
import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { StorageService } from './storage.service'

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
