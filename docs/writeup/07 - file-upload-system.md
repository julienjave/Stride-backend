# File upload system

This document covers the shared image-upload pattern built to close out three
previously deferred fields: `users.avatarPath`, `clinics.logoPath`, and
`exercises.mediaUrls`.

## One shared mechanism, not three separate ones

All three fields were deliberately left out of their respective create/update
DTOs early on, since a real file upload needs different HTTP handling than a
JSON body (`multipart/form-data`, parsed via Multer, exposed through NestJS's
`FileInterceptor`/`FilesInterceptor` and `@UploadedFile()`/`@UploadedFiles()`)
— and all three are the same underlying shape: accept a file, upload it via
`StorageService`, persist the resulting object key. A single shared Multer
configuration (`common/config/image-upload.config.ts`) is used by all three
routes, rather than three slightly-different copies that could drift apart:
memory storage (files are immediately re-uploaded to RustFS, so writing to
local disk first would be pure overhead), a 5MB size limit, and a `fileFilter`
restricting uploads to JPEG/PNG/WebP.

`common/config/`, not the plain `src/config/`, is the deliberate location —
this file is meaningless outside a running NestJS request pipeline (it only
makes sense passed to `@UseInterceptors`), unlike `database-url.ts`, which is
plain infrastructure glue also used by standalone scripts with no NestJS
involved at all. The same "does this need Nest running at all" question
decided the earlier `local-auth.guard.ts` placement (`auth/guards/` vs.
`common/guards/`).

Each of the three modules now imports `StorageModule` directly (a real,
one-directional dependency — `UsersModule`/`ClinicsModule`/`ExercisesModule`
each need `StorageService`, and `StorageModule` needs nothing back from any
of them, so no circularity risk).

## Authorization reuses existing rules, rather than inventing new ones

- **Avatar** (`POST /users/:id/avatar`) — self or admin, the same rule
  already governing `PATCH /users/:id`.
- **Logo** (`POST /clinics/:id/logo`) — admin only, matching
  `PATCH /clinics/:id`.
- **Exercise images** (`POST /exercises/:id/images`) — reuses
  `assertCanModify` verbatim. Adding an image to an exercise is the same
  "are you allowed to touch this" question as editing its text fields, not a
  separate rule to design.

## Exercise images: add, remove, and reorder — deliberately not a rigid schema

The source dataset gives most exercises two genuinely distinct images (a
movement's start and end position), with no field indicating which is which
— purely an inferred convention from array order, not real structured data.
Building a rigid two-slot schema (`startImage`/`endImage`) around that
convention would over-fit to one dataset's authoring habit, and would break
down entirely for practitioner-authored custom exercises, which have no
guaranteed start/end pair at all.

The resolution: `mediaUrls` stays a plain ordered array, with three
operations, each independently authorized via `assertCanModify`:

- `addImages` — appends, rather than replacing. A full replace would
  silently delete a seeded exercise's existing, still-useful images the
  moment someone uploaded one new photo.
- `removeImage` — validates the target object key is genuinely one of this
  exercise's own images *before* deleting anything, closing an IDOR-shaped
  gap: without that check, any client-supplied key could be deleted from the
  bucket, not just ones actually belonging to the exercise in question. Also
  calls `StorageService.delete()` (a new method, added specifically for
  this) — removing a database reference without freeing the underlying
  object would hide the storage waste rather than eliminate it.
- `reorderImages` — accepts a full replacement ordering and validates it is
  an exact permutation of the current images (same set of keys, different
  order), rejecting anything that would sneak an add or remove past
  `assertCanModify` disguised as a reorder.

**"Cover image" was deliberately not built as its own field.** An initial
plan to add a separate `coverImageUrl` column was reconsidered before
implementation: it would need to stay in sync with `mediaUrls` indefinitely,
and would silently point at nothing the moment its referenced image was
removed — the same "two sources of truth" failure mode this project has
repeatedly hit and corrected in its infrastructure configuration. Instead,
the cover image is defined as simply `mediaUrls[0]` — the first image in the
array. This makes "reorder" and "set as cover" the same operation: moving an
image to the front of the array *is* setting it as the cover, with nothing
new to build, and nothing that can ever drift out of sync, since it's derived
from the one array that already is the single source of truth.
