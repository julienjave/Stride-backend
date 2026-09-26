import { Logger } from '@nestjs/common'
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