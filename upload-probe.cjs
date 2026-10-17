// A one-off diagnostic, NOT part of the app: uploads a photo to the RUNNING
// backend the way the browser does (log in, then a multipart POST), but from
// Node — no browser involved. It tells us whether the hang is in the backend
// (this hangs too) or in the browser / the file on disk (this works).
//
// Usage, from anywhere, with the backend running on :3000:
//   node upload-probe.cjs <email> <password> <path-to-photo> [programId] [exerciseRowId]
// e.g.
//   node upload-probe.cjs you@example.com yourPassword "C:\Users\you\Pictures\IMG_1234.JPG" 44 174
// It adds the photo to that program exercise's OWN photos (not shown to the
// patient while "Photos from the library" is chosen); remove it afterwards on
// the photo page. Delete this file when done.
const fs = require('node:fs')
const path = require('node:path')

const [email, password, filePath, programId = '44', rowId = '174'] = process.argv.slice(2)
const API = 'http://localhost:3000'

// Every step is given 20 s; past that it says where it stopped.
function timed(label, promise) {
  const started = Date.now()
  const limit = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`no answer after 20 s`)), 20_000),
  )
  return Promise.race([promise, limit]).then(
    (value) => {
      console.log(`OK       ${label} — ${Date.now() - started} ms`)
      return value
    },
    (error) => {
      console.log(`FAILED   ${label} — ${Date.now() - started} ms — ${error.message}`)
      process.exit(1)
    },
  )
}

;(async () => {
  console.log(`Node ${process.version}, backend ${API}\n`)

  // 1. Reading the file from disk (a OneDrive "online-only" file, say, has
  //    to be downloaded first).
  const bytes = await timed(`read ${path.basename(filePath)}`, fs.promises.readFile(filePath))
  console.log(`         ${bytes.length} bytes, starts with ${bytes.subarray(0, 4).toString('hex')} (ffd8ff = JPEG)`)

  // 2. Logging in: the session cookie comes back in Set-Cookie.
  const login = await timed(
    'log in',
    fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  )
  if (!login.ok) {
    console.log(`         login refused: ${login.status} ${await login.text()}`)
    process.exit(1)
  }
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')

  // 3. The upload, as the browser sends it: field "files", type image/jpeg.
  const form = new FormData()
  form.append('files', new Blob([bytes], { type: 'image/jpeg' }), path.basename(filePath))
  const response = await timed(
    `POST /assigned-programs/${programId}/exercises/${rowId}/images`,
    fetch(`${API}/assigned-programs/${programId}/exercises/${rowId}/images`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    }),
  )
  const text = await response.text()
  console.log(`         ${response.status} ${response.ok ? '(stored)' : text.slice(0, 300)}`)
})()
