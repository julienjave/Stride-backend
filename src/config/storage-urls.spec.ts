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

import { storageInternalEndpoint, storagePublicEndpoint } from './storage-urls'

// Plain objects as the environment — the functions take `env` as a
// parameter, so no test touches the real process.env.

describe('storageInternalEndpoint', () => {
  it('is localhost:9000 when nothing is set', () => {
    expect(storageInternalEndpoint({})).toBe('http://localhost:9000')
  })

  it('is the Compose service in production', () => {
    expect(
      storageInternalEndpoint({
        STORAGE_ENDPOINT: 'storage',
        STORAGE_PORT: '9000',
      }),
    ).toBe('http://storage:9000')
  })
})

describe('storagePublicEndpoint', () => {
  describe('unset', () => {
    it('falls back to the internal address outside production (local development is unchanged)', () => {
      expect(storagePublicEndpoint({})).toBe('http://localhost:9000')
      expect(
        storagePublicEndpoint({
          STORAGE_ENDPOINT: '127.0.0.1',
          STORAGE_PORT: '9100',
        }),
      ).toBe('http://127.0.0.1:9100')
    })

    it('counts an empty or blank value as unset', () => {
      expect(storagePublicEndpoint({ STORAGE_PUBLIC_URL: '' })).toBe(
        'http://localhost:9000',
      )
      expect(storagePublicEndpoint({ STORAGE_PUBLIC_URL: '   ' })).toBe(
        'http://localhost:9000',
      )
    })

    it('is REFUSED in production, naming the setting and the internal address', () => {
      const run = () =>
        storagePublicEndpoint({
          NODE_ENV: 'production',
          STORAGE_ENDPOINT: 'storage',
        })
      expect(run).toThrow(
        /^Missing required environment variable: STORAGE_PUBLIC_URL/,
      )
      expect(run).toThrow(/http:\/\/storage:9000/)
    })
  })

  describe('set', () => {
    it('answers the origin, normalised', () => {
      expect(
        storagePublicEndpoint({
          STORAGE_PUBLIC_URL: 'https://files.stridecare.app',
        }),
      ).toBe('https://files.stridecare.app')
      // A trailing slash, capitals, the scheme's default port, spaces around.
      expect(
        storagePublicEndpoint({
          STORAGE_PUBLIC_URL: '  https://Files.StrideCare.app:443/  ',
        }),
      ).toBe('https://files.stridecare.app')
    })

    it('keeps a port that is not the default', () => {
      expect(
        storagePublicEndpoint({
          STORAGE_PUBLIC_URL: 'http://192.168.1.20:9000',
        }),
      ).toBe('http://192.168.1.20:9000')
    })

    it('accepts https:// in production', () => {
      expect(
        storagePublicEndpoint({
          NODE_ENV: 'production',
          STORAGE_PUBLIC_URL: 'https://files.stridecare.app',
        }),
      ).toBe('https://files.stridecare.app')
    })

    it('refuses http:// in production (an https page blocks http images)', () => {
      expect(() =>
        storagePublicEndpoint({
          NODE_ENV: 'production',
          STORAGE_PUBLIC_URL: 'http://files.stridecare.app',
        }),
      ).toThrow(/must be an https:\/\/ address in production/)
    })

    it.each([
      ['no scheme', 'files.stridecare.app'],
      ['not a URL', 'https://files stridecare.app'],
    ])('refuses %s', (_case, value) => {
      expect(() =>
        storagePublicEndpoint({ STORAGE_PUBLIC_URL: value }),
      ).toThrow(/^STORAGE_PUBLIC_URL must be an absolute address/)
    })

    it('refuses a scheme other than http(s)', () => {
      expect(() =>
        storagePublicEndpoint({
          STORAGE_PUBLIC_URL: 'ftp://files.stridecare.app',
        }),
      ).toThrow(/^STORAGE_PUBLIC_URL must start with https:\/\//)
    })

    it.each([
      ['a path', 'https://files.stridecare.app/storage'],
      ['a query', 'https://files.stridecare.app/?x=1'],
      ['a fragment', 'https://files.stridecare.app/#top'],
      ['a user name', 'https://admin@files.stridecare.app'],
      ['a password', 'https://admin:secret@files.stridecare.app'],
    ])('refuses %s', (_case, value) => {
      expect(() =>
        storagePublicEndpoint({ STORAGE_PUBLIC_URL: value }),
      ).toThrow(/^STORAGE_PUBLIC_URL must be just a scheme and a host/)
    })
  })
})
