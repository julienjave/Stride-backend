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
// npm run docs:links — does every link in the documentation lead somewhere?
//
// THE SAME FILE is in both repositories (scripts/check-doc-links.mjs): when
// you change one, copy it to the other. It knows both repositories (REPOS
// below) and finds out which one it is running in from package.json's name.
//
// What it checks, in every .md file of this repository:
//   - relative links (`../PROJECT.md`, `../../src/main.ts`): the file exists,
//     with its exact letter case (Windows and macOS ignore case, GitHub
//     doesn't, so `Testing.md` would work here and 404 there);
//   - #anchors: the target file has a heading whose GitHub slug is that
//     anchor ("Part 1 — Local development" → `part-1--local-development`);
//   - GitHub links to either repository
//     (github.com/julienjave/Stride-frontend/blob/main/docs/X.md#y, written
//     here without https:// so this file doesn't check its own example),
//     checked against the other repository's folder on this machine: the
//     file and anchor as above, `blob/` for a file and `tree/` for a folder,
//     the branch `main`. Also the GitHub URLs written outside links: in code
//     blocks, `.env.example`, comments.
// It also counts `TODO-LINK`, the placeholder for addresses that don't exist
// yet (reported, never an error).
//
// Exit code 1 if any link is broken, so it can gate a commit or a CI step.
// Before checking anything, it checks ITSELF (selfTest below): a small fake
// pair of repositories with known mistakes, which it must report exactly.
// A checker that passed for the wrong reason would prove nothing.
//
// The other repository is looked for beside this one, as `../frontend` or
// `../Stride-frontend` (`backend` / `Stride-backend` from the frontend), or
// where STRIDE_FRONTEND_DIR / STRIDE_BACKEND_DIR says. Not found: its links
// are listed as unchecked, and the run doesn't fail for them.
//
// Only Node's own modules: nothing to install, nothing to compile.

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const OWNER = 'julienjave'
const BRANCH = 'main'
// GitHub name → package.json name, folder names tried beside this repo, and
// the variable that can say where it is instead.
const REPOS = {
  'Stride-backend': {
    packageName: 'stride-backend',
    folders: ['backend', 'Stride-backend'],
    envVar: 'STRIDE_BACKEND_DIR',
  },
  'Stride-frontend': {
    packageName: 'stride-frontend',
    folders: ['frontend', 'Stride-frontend'],
    envVar: 'STRIDE_FRONTEND_DIR',
  },
}
// Links known to be broken, each with its reason: printed, never an error.
const KNOWN_EXCEPTIONS = {
  'Stride-backend': [
    {
      file: 'docs/journal/22-scoped-bug-hunt-and-verification-loop.md',
      target: '../deferred-improvements.md',
      why: 'a private working file; the journal README explains it',
    },
  ],
  'Stride-frontend': [],
}
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-e2e',
  'coverage',
])

// ---------------------------------------------------------------------------
// Reading Markdown

// Every file under `root` (folders in SKIP_DIRS left out), as paths relative
// to root with forward slashes, sorted so the output is the same everywhere.
function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, full, out)
    } else if (entry.isFile()) {
      out.push(toSlash(path.relative(root, full)))
    }
  }
  return out.sort()
}

const toSlash = (p) => p.replace(/\\/g, '/')

// The files GitHub will show: git's tracked files plus new ones not yet
// added, minus everything .gitignore excludes (`--exclude-standard`). So a
// snapshot written at the root (a second copy of every doc, binary bytes
// included), node_modules or a build is never read. `-z` ends each name with
// a NUL byte, so names with spaces or accents arrive as they are (otherwise
// git quotes them). A file deleted but not yet committed is still listed by
// git, hence the existence check. Without git, or outside a repository,
// every file under root is walked instead.
function publishedFiles(root) {
  let listed
  try {
    listed = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch {
    return walk(root)
  }
  return listed
    .split('\0')
    .filter((rel) => rel && isFile(path.join(root, rel)))
    .sort()
}

const isFile = (p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// The text with CRLF turned into LF, so one set of patterns fits both kinds
// of files. `fatal: true` makes a non-UTF-8 file (an image) throw instead of
// becoming garbage: the caller then skips it.
function readText(file) {
  const bytes = readFileSync(file)
  return new TextDecoder('utf-8', { fatal: true })
    .decode(bytes)
    .replace(/\r\n/g, '\n')
}

// Code isn't prose: a link-like `[x](y)` in a code block or in `inline code`
// is an example, not a link. Fenced blocks are blanked (keeping the line
// count), and with `inline` also the inline code spans. A fence closes on
// the same character, at least as long as it opened (CommonMark's rule).
function stripCode(text, inline = true) {
  const out = []
  let fence = null
  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null
      out.push('')
    } else if (m) {
      fence = m[1]
      out.push('')
    } else {
      out.push(inline ? line.replace(/`[^`]*`/g, '') : line)
    }
  }
  return out.join('\n')
}

// GitHub's anchor for a heading: the link text kept and its address dropped,
// backticks removed, lower case, then only letters, digits, spaces, hyphens
// and underscores kept, and each space made a hyphen. So "Part 1 — Local
// development" loses its dash and keeps both spaces: part-1--local-development.
// \p{L} and \p{N} (any alphabet's letters and digits) keep "é" in a slug.
function slug(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-')
}

// Every anchor a Markdown file offers. A repeated heading gets -1, -2… as on
// GitHub. Cached: a file is often the target of many links.
const anchorCache = new Map()
function anchorsOf(file) {
  if (!anchorCache.has(file)) {
    const seen = new Map()
    const anchors = new Set()
    for (const line of stripCode(readText(file), false).split('\n')) {
      const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
      if (!m) continue
      const s = slug(m[1])
      const n = seen.get(s) ?? 0
      anchors.add(n === 0 ? s : `${s}-${n}`)
      seen.set(s, n + 1)
    }
    anchorCache.set(file, anchors)
  }
  return anchorCache.get(file)
}

// ---------------------------------------------------------------------------
// Does a path exist — with this exact letter case?

// Each folder's listing, read once.
const listingCache = new Map()
function listing(dir) {
  if (!listingCache.has(dir)) {
    let names
    try {
      names = new Set(readdirSync(dir))
    } catch {
      names = new Set()
    }
    listingCache.set(dir, names)
  }
  return listingCache.get(dir)
}

// The path must be inside `base` (a repository root) to be checked segment by
// segment against the real listings; above it (a link out of the repo) only
// plain existence can be asked.
function existsExactly(target, base) {
  const rel = path.relative(base, target)
  if (rel === '') return true
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    try {
      statSync(target)
      return true
    } catch {
      return false
    }
  }
  let dir = base
  for (const part of rel.split(path.sep)) {
    if (!listing(dir).has(part)) return false
    dir = path.join(dir, part)
  }
  return true
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// null when fine, otherwise what's wrong. `kind`: 'blob' wants a file,
// 'tree' a folder (GitHub redirects the wrong one — still a mistake to fix).
function checkLocal(target, anchor, base, kind) {
  if (!existsExactly(target, base)) return 'missing'
  if (kind === 'blob' && isDir(target)) return 'is a folder (use tree/)'
  if (kind === 'tree' && !isDir(target)) return 'is a file (use blob/)'
  if (anchor && target.endsWith('.md') && !anchorsOf(target).has(anchor)) {
    return `no anchor #${anchor}`
  }
  return null
}

// ---------------------------------------------------------------------------
// GitHub links

// https://github.com/<owner>/<repo>[.git][/(blob|tree)/<branch>/<path>][#anchor]
const GITHUB_LINK =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(blob|tree)\/([^/\s#)]+)\/([^\s#)`"'>]*))?(?:#([\w-]+))?(?=[\s)`"'>]|$)/u

// { checked, problem, unchecked } for one URL. `local` maps a GitHub repo
// name (lower case: GitHub ignores case in names) to its folder or null.
function checkGithub(url, local) {
  const m = GITHUB_LINK.exec(url)
  if (!m || m[1].toLowerCase() !== OWNER) return { checked: false }
  const [, , repo, kind, branch, file, anchor] = m
  if (!local.has(repo.toLowerCase()))
    return { checked: true, problem: 'unknown repository' }
  const dir = local.get(repo.toLowerCase())
  if (dir === null) return { checked: false, unchecked: true }
  if (!kind)
    return {
      checked: true,
      problem: anchor ? 'fragment on a repository root' : null,
    }
  if (branch !== BRANCH)
    return { checked: true, problem: `branch ${branch}, expected ${BRANCH}` }
  const target = path.join(dir, ...file.replace(/\/$/, '').split('/'))
  return { checked: true, problem: checkLocal(target, anchor, dir, kind) }
}

// ---------------------------------------------------------------------------
// One repository

const LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const ANY_GITHUB_URL = /https:\/\/github\.com\/[^\s)`"'>]+/g

// Checks `root`; `local` = Map(lower-case GitHub name → folder or null).
// Returns counts and lists; prints nothing (the self-test calls it too).
function checkRepository(root, local, exceptions = []) {
  anchorCache.clear()
  listingCache.clear()
  const result = {
    relative: 0,
    github: 0,
    problems: [],
    known: [],
    unchecked: 0,
    todo: new Map(),
  }
  const isException = (file, target) =>
    exceptions.find((e) => e.file === file && e.target === target)
  const report = (file, target, problem) => {
    const known = isException(file, target)
    if (known)
      result.known.push(`${file}: ${target}: ${problem} — ${known.why}`)
    else result.problems.push(`${file}: ${target}: ${problem}`)
  }
  const seen = new Set()
  const files = publishedFiles(root)

  for (const rel of files.filter((f) => f.endsWith('.md'))) {
    const file = path.join(root, rel)
    let raw
    try {
      raw = readText(file)
    } catch {
      // A published .md that isn't UTF-8 is a problem of its own: GitHub
      // would show it garbled.
      result.problems.push(`${rel}: (the file itself): not valid UTF-8`)
      continue
    }
    const todos = raw.split('TODO-LINK').length - 1
    if (todos) result.todo.set(rel, todos)
    for (const [, target] of stripCode(raw).matchAll(LINK)) {
      if (target === 'TODO-LINK') continue
      if (target.startsWith('https://github.com/')) {
        const r = checkGithub(target, local)
        // Remembered whatever the answer, so the text pass below doesn't
        // count the same link a second time.
        seen.add(`${rel}\n${target}`)
        if (r.unchecked) result.unchecked++
        if (!r.checked) continue
        result.github++
        if (r.problem) report(rel, target, r.problem)
        continue
      }
      if (/^[a-z]+:/.test(target)) continue // http:, mailto:… — not ours to check
      result.relative++
      const hash = target.indexOf('#')
      const linkPath = hash === -1 ? target : target.slice(0, hash)
      const anchor = hash === -1 ? '' : target.slice(hash + 1)
      const dest = linkPath
        ? path.join(path.dirname(file), ...linkPath.split('/'))
        : file
      const problem = checkLocal(dest, anchor, root)
      if (problem) report(rel, target, problem)
    }
  }

  // GitHub URLs outside Markdown links, in any text file.
  for (const rel of files) {
    let raw
    try {
      raw = readText(path.join(root, rel))
    } catch {
      continue // not text (an image, a font)
    }
    for (let [url] of raw.matchAll(ANY_GITHUB_URL)) {
      url = url.replace(/[.,;:]+$/, '')
      if (seen.has(`${rel}\n${url}`)) continue
      const r = checkGithub(url, local)
      seen.add(`${rel}\n${url}`)
      if (r.unchecked) result.unchecked++
      if (!r.checked) continue
      result.github++
      if (r.problem) report(rel, url, r.problem)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// The self-test: two fake repositories, every kind of mistake planted once.

function selfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), 'stride-doc-links-'))
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
  const gh = `https://github.com/${OWNER}/Stride-frontend`
  try {
    write(
      'frontend/docs/Guide.md',
      '# Guide\n\n## Part 1 — Local development\n\n## Notes\n\n## Notes\n',
    )
    write('frontend/e2e/a.ts', '')
    write(
      'backend/README.md',
      [
        '[ok](docs/A.md) [ok](docs/A.md#café-au-lait) [ok](#readme) [ok](docs/A.md#same-1)',
        `[ok](${gh}/blob/main/docs/Guide.md#part-1--local-development) [ok](${gh}/tree/main/e2e)`,
        `[ok](${gh}) [ok](${gh}/blob/main/docs/Guide.md#notes-1) [ok](TODO-LINK) [ok](https://example.com)`,
        '`[code](nope.md)`',
        '```',
        '[code](nope.md)',
        '```',
        '# README',
        '',
        '[1](docs/missing.md) [2](docs/a.md) [3](docs/A.md#nope) [4](docs/known.md)',
        `[5](${gh}/blob/main/docs/guide.md) [6](${gh}/blob/main/e2e) [7](${gh}/tree/main/docs/Guide.md)`,
        `[8](${gh}/blob/master/docs/Guide.md) [9](https://github.com/${OWNER}/Stride-backnd)`,
        `[10](${gh}/blob/main/docs/Guide.md#nope) TODO-LINK`,
        '',
      ].join('\r\n'), // CRLF on purpose: must read the same as LF
    )
    write('backend/docs/A.md', '# A\n\n## Café au lait\n\n## Same\n\n## Same\n')
    write('backend/.env.example', `# X=${gh}/blob/main/docs/Nope.md\n`)
    write('backend/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]))
    // A published .md that isn't UTF-8: reported, not a crash.
    write('backend/docs/bad.md', Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]))
    // With git: the fixture becomes a repository, and an IGNORED snapshot
    // (a broken link, binary bytes) must not be read at all. Without git the
    // folder is walked, so the snapshot isn't written.
    let usesGit = false
    try {
      execFileSync('git', ['init', '-q'], {
        cwd: path.join(dir, 'backend'),
        stdio: 'ignore',
      })
      usesGit = true
    } catch {
      // no git on this machine: the walk is tested instead
    }
    if (usesGit) {
      write('backend/.gitignore', 'snapshot.md\n')
      write(
        'backend/snapshot.md',
        Buffer.concat([
          Buffer.from(`[x](nope.md) [y](${gh}/blob/main/nope.md) TODO-LINK `),
          Buffer.from([0xff, 0xfe]),
        ]),
      )
    }

    const local = new Map([
      ['stride-backend', path.join(dir, 'backend')],
      ['stride-frontend', path.join(dir, 'frontend')],
    ])
    const known = [
      { file: 'README.md', target: 'docs/known.md', why: 'planted' },
    ]
    const r = checkRepository(path.join(dir, 'backend'), local, known)
    const expected = [
      'README.md: docs/missing.md: missing',
      'README.md: docs/a.md: missing',
      'README.md: docs/A.md#nope: no anchor #nope',
      `README.md: ${gh}/blob/main/docs/guide.md: missing`,
      `README.md: ${gh}/blob/main/e2e: is a folder (use tree/)`,
      `README.md: ${gh}/tree/main/docs/Guide.md: is a file (use blob/)`,
      `README.md: ${gh}/blob/master/docs/Guide.md: branch master, expected main`,
      `README.md: https://github.com/${OWNER}/Stride-backnd: unknown repository`,
      `README.md: ${gh}/blob/main/docs/Guide.md#nope: no anchor #nope`,
      `.env.example: ${gh}/blob/main/docs/Nope.md: missing`,
      'docs/bad.md: (the file itself): not valid UTF-8',
    ]
    const failures = []
    const got = [...r.problems].sort()
    if (JSON.stringify(got) !== JSON.stringify([...expected].sort())) {
      failures.push(
        `problems:\n    got      ${got.join('\n             ')}\n    expected ${expected.join('\n             ')}`,
      )
    }
    if (r.known.length !== 1)
      failures.push(`known exceptions: got ${r.known.length}, expected 1`)
    if (r.relative !== 8)
      failures.push(`relative links: got ${r.relative}, expected 8`)
    if (r.github !== 11)
      failures.push(`GitHub links: got ${r.github}, expected 11`)
    if (r.todo.get('README.md') !== 2)
      failures.push(`TODO-LINK: got ${r.todo.get('README.md')}, expected 2`)

    // The other repository not found: its 10 links are counted once each as
    // unchecked, and none of them is reported broken.
    local.set('stride-frontend', null)
    const alone = checkRepository(path.join(dir, 'backend'), local, known)
    if (alone.unchecked !== 10)
      failures.push(`unchecked links: got ${alone.unchecked}, expected 10`)
    if (alone.problems.some((p) => p.includes('Stride-frontend')))
      failures.push('a link to a repository not found was reported broken')
    return failures
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// The command

function packageName(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name
  } catch {
    return undefined
  }
}

// The folder of each repository: this one, and the other where it is found.
function locateRepositories(root) {
  const own = packageName(root)
  const self = Object.keys(REPOS).find(
    (name) => REPOS[name].packageName === own,
  )
  if (!self)
    throw new Error(`${root} is neither repository (package.json name: ${own})`)
  const local = new Map([[self.toLowerCase(), root]])
  const notes = []
  for (const [name, repo] of Object.entries(REPOS)) {
    if (name === self) continue
    const candidates = process.env[repo.envVar]
      ? [path.resolve(process.env[repo.envVar])]
      : repo.folders.map((f) => path.resolve(root, '..', f))
    const found =
      candidates.find((dir) => packageName(dir) === repo.packageName) ?? null
    local.set(name.toLowerCase(), found)
    notes.push(
      found
        ? `${name}: ${found}`
        : `${name}: not found (tried ${candidates.join(', ')}; set ${repo.envVar})`,
    )
  }
  return { self, local, notes }
}

function main() {
  const failures = selfTest()
  if (failures.length > 0) {
    console.error(
      'The link checker failed its own test, so its answer would mean nothing:',
    )
    for (const f of failures) console.error(`  - ${f}`)
    process.exitCode = 2
    return
  }
  // npm runs a script from the folder holding package.json: the repo's root.
  const root = process.cwd()
  const { self, local, notes } = locateRepositories(root)
  const r = checkRepository(root, local, KNOWN_EXCEPTIONS[self])

  console.log(
    `Checking ${self} (self-test passed). The other repository — ${notes.join('; ')}`,
  )
  for (const p of r.problems) console.log(`BROKEN  ${p}`)
  for (const k of r.known) console.log(`known   ${k}`)
  if (r.unchecked)
    console.log(
      `${r.unchecked} GitHub link(s) to the other repository not checked: it wasn't found.`,
    )
  const todoTotal = [...r.todo.values()].reduce((a, b) => a + b, 0)
  console.log(
    `${r.relative} relative links, ${r.github} GitHub links, ${r.problems.length} broken, ` +
      `${r.known.length} known; TODO-LINK ${todoTotal}`,
  )
  for (const [file, n] of r.todo)
    console.log(`  ${String(n).padStart(3)}  ${file}`)
  if (r.problems.length > 0) process.exitCode = 1
}

main()
