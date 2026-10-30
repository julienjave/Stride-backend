import { CACHEABLE_URL_WINDOW_SECONDS, cacheableSigning } from './cacheable-url'

// Dates written in UTC ('Z'): the rule must not depend on the backend's own
// time zone (the sandbox runs Paris time, the person's Docker UTC). Pinned
// far from today, like every test clock in the project.
describe('cacheableSigning', () => {
  it('signs at the start of the hour, for the whole hour', () => {
    expect(
      cacheableSigning(new Date('2031-03-04T14:00:00.000Z')).signingDate,
    ).toStrictEqual(new Date('2031-03-04T14:00:00.000Z'))
    expect(
      cacheableSigning(new Date('2031-03-04T14:27:13.500Z')).signingDate,
    ).toStrictEqual(new Date('2031-03-04T14:00:00.000Z'))
    expect(
      cacheableSigning(new Date('2031-03-04T14:59:59.999Z')).signingDate,
    ).toStrictEqual(new Date('2031-03-04T14:00:00.000Z'))
  })

  it('moves to the next hour at the first millisecond of it', () => {
    expect(
      cacheableSigning(new Date('2031-03-04T15:00:00.000Z')).signingDate,
    ).toStrictEqual(new Date('2031-03-04T15:00:00.000Z'))
  })

  // The point of a lifetime of TWO windows: a URL handed out at the LAST
  // moment of its window still has a full hour left.
  it('leaves at least a full hour of validity after any moment of the window', () => {
    for (const moment of [
      '2031-03-04T14:00:00.000Z',
      '2031-03-04T14:30:00.000Z',
      '2031-03-04T14:59:59.999Z',
    ]) {
      const now = new Date(moment)
      const { signingDate, expiresIn } = cacheableSigning(now)
      const validUntil = signingDate.getTime() + expiresIn * 1000
      expect(validUntil - now.getTime()).toBeGreaterThan(
        CACHEABLE_URL_WINDOW_SECONDS * 1000,
      )
    }
    expect(cacheableSigning(new Date()).expiresIn).toBe(7200)
  })

  it('asks storage for a browser-only cache of one hour', () => {
    expect(cacheableSigning(new Date()).cacheControl).toBe(
      'private, max-age=3600',
    )
  })
})
