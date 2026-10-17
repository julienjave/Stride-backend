// A one-off diagnostic, NOT part of the app: talks to the storage server
// (RustFS) directly, the way StorageService does, and times each call — so
// we learn whether uploads hang in STORAGE, with nothing else (no browser,
// no Nest, no Multer, no database) in the way.
//
// Run it from the backend folder (so it finds node_modules), with RustFS up:
//   node storage-probe.cjs
// Each call gives up after 10 s, so the whole run takes at most ~1 minute.
// Delete the file afterwards; it writes and then deletes "probe/*" objects.
const {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3')

const endpoint = `http://${process.env.STORAGE_ENDPOINT ?? 'localhost'}:${process.env.STORAGE_PORT ?? 9000}`
const bucket = 'stride'

// The app's settings, plus a 10 s limit so a hang shows up as "TIMEOUT"
// instead of waiting forever. `extra` changes ONE setting per test.
function client(extra = {}) {
  return new S3Client({
    endpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.RUSTFS_ACCESS_KEY ?? 'rustfsadmin',
      secretAccessKey: process.env.RUSTFS_SECRET_KEY ?? 'rustfsadmin',
    },
    forcePathStyle: true,
    maxAttempts: 1, // no retries: one try, one answer
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: 10_000,
      throwOnRequestTimeout: true,
    },
    ...extra,
  })
}

async function attempt(label, s3, command) {
  const started = Date.now()
  try {
    await s3.send(command)
    console.log(`OK       ${label} — ${Date.now() - started} ms`)
  } catch (error) {
    const kind = error.name === 'TimeoutError' ? 'TIMEOUT ' : 'ERROR   '
    console.log(`${kind} ${label} — ${Date.now() - started} ms — ${error.name}: ${error.message}`)
  }
}

const put = (key, bytes) =>
  new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.alloc(bytes, 7), ContentType: 'image/jpeg' })

;(async () => {
  console.log(`Storage at ${endpoint}, Node ${process.version}\n`)
  const app = client()
  // 1. Reaching the server at all (what the app does at startup).
  await attempt('HeadBucket (is the server answering?)', app, new HeadBucketCommand({ Bucket: bucket }))
  // 2. A copy — the call that works for you in the app.
  await attempt('PutObject 1 KB, app settings', app, put('probe/tiny.jpg', 1_000))
  await attempt(
    'CopyObject (like "Add the library\'s photos")',
    app,
    new CopyObjectCommand({ Bucket: bucket, Key: 'probe/copy.jpg', CopySource: `${bucket}/probe/tiny.jpg` }),
  )
  // 3. Your photo's size, exactly as the app sends it.
  await attempt('PutObject 450 KB, app settings', app, put('probe/450k.jpg', 450_000))
  // 4. The same, WITHOUT the CRC32 checksum header the SDK adds by default
  //    (x-amz-checksum-crc32) — if only this one works, RustFS is the
  //    problem with that header.
  await attempt(
    'PutObject 450 KB, no checksum header',
    client({ requestChecksumCalculation: 'WHEN_REQUIRED' }),
    put('probe/450k-nocrc.jpg', 450_000),
  )
  // 5. Through 127.0.0.1 instead of "localhost" (on Windows, Node tries
  //    IPv6 ::1 first, which Docker Desktop forwards differently).
  await attempt(
    'PutObject 450 KB, via 127.0.0.1',
    client({ endpoint: endpoint.replace('localhost', '127.0.0.1') }),
    put('probe/450k-ipv4.jpg', 450_000),
  )
  // Clean up whatever was stored.
  for (const key of ['tiny', 'copy', '450k', '450k-nocrc', '450k-ipv4']) {
    await app.send(new DeleteObjectCommand({ Bucket: bucket, Key: `probe/${key}.jpg` })).catch(() => {})
  }
})()
