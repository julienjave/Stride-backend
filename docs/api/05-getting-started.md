# Getting Started — A Real Walkthrough

A complete, working sequence: bootstrap a clinic, create a practitioner and
a patient, create an exercise, and assign a program to that patient. Every
request body below matches the actual DTO validation rules in the code
(`src/**/dto/*.dto.ts`) — field names, required-vs-optional, and enum values
are all real, not illustrative.

These examples use `curl` with a cookie jar (`-c`/`-b cookies.txt`) to show
session persistence explicitly across calls — a real frontend would instead
rely on the browser handling the `connect.sid` cookie automatically via
`fetch(url, { credentials: 'include' })`. A `fetch` equivalent is shown for
the first call as a reference; every other step follows the identical
pattern with `credentials: 'include'`.

Assume the API is running at `http://localhost:3000` (the local default;
adjust for your environment).

## 1. Register the clinic + founding admin

`POST /auth/register-clinic` only works **once** — before any admin account
exists anywhere in the system (see [Authentication](./01-authentication.md)).
It creates the clinic and its first admin together, and logs that admin in
immediately.

```bash
curl -i -c cookies.txt -X POST http://localhost:3000/auth/register-clinic \
  -H "Content-Type: application/json" \
  -d '{
    "clinicName": "Riverside Physiotherapy",
    "clinicEmail": "contact@riverside-physio.example",
    "clinicPhone": "555-0100",
    "email": "admin@riverside-physio.example",
    "password": "correct-horse-battery-staple",
    "firstName": "Alex",
    "lastName": "Chen",
    "position": "Clinic Director"
  }'
```

Equivalent with `fetch` (browser):

```js
const res = await fetch('http://localhost:3000/auth/register-clinic', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    clinicName: 'Riverside Physiotherapy',
    clinicEmail: 'contact@riverside-physio.example',
    clinicPhone: '555-0100',
    email: 'admin@riverside-physio.example',
    password: 'correct-horse-battery-staple',
    firstName: 'Alex',
    lastName: 'Chen',
    position: 'Clinic Director',
  }),
})
const admin = await res.json()
```

`→ 201 Created`

```json
{
  "id": 1,
  "email": "admin@riverside-physio.example",
  "firstName": "Alex",
  "lastName": "Chen",
  "avatarPath": null,
  "isActive": true,
  "createdAt": "2026-08-05T14:00:00.000Z",
  "roles": ["admin"],
  "activeRole": "admin",
  "clinicId": 1
}
```

Note the `connect.sid` session cookie from this response is now stored in
`cookies.txt` — every subsequent call as the admin needs `-b cookies.txt`.
Keep `clinicId: 1` handy; it's needed below.

## 2. Create a practitioner (as the admin)

`POST /users` — `@Roles('practitioner', 'admin')`, so the currently-logged-in
admin can call this. `role: 'practitioner'` makes `licenseNumber` required
(`CreateUserDto` — `licenseNumber` is validated only when `role ===
'practitioner'`, via `@ValidateIf`). Pass `clinicId` so this practitioner is
actually linked to the clinic — without this, the clinic-scoped "which
patients does this practitioner manage" checks used everywhere else in the
API (assigning programs, viewing medical files, messaging, etc.) will never
find a match.

```bash
curl -i -c cookies-practitioner.txt -b cookies.txt -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{
    "email": "dr.smith@riverside-physio.example",
    "password": "another-strong-password-1",
    "role": "practitioner",
    "firstName": "Jordan",
    "lastName": "Smith",
    "licenseNumber": "PT-2024-00931",
    "specialties": ["sports rehab", "post-surgical"],
    "clinicId": 1
  }'
```

`→ 201 Created` — the new practitioner's account. It is **not** logged in
by this call — `POST /users` never touches the caller's session, unlike the
`/auth/*` routes (`register`, `register-clinic`, `login`), which do
establish a session for the account they create or authenticate. The admin
making this call remains logged in as the admin; the practitioner needs
their own separate `POST /auth/login` (step 3) before anything they do
counts as coming from them.

## 3. Log in as the practitioner

The practitioner account has exactly one role, so `role` can be omitted from
the login body entirely (see [Authentication](./01-authentication.md) for
what happens if an account has more than one).

```bash
curl -i -c practitioner-cookies.txt -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "dr.smith@riverside-physio.example",
    "password": "another-strong-password-1"
  }'
```

`→ 201 Created` with the practitioner's user object. From here on, every
call as the practitioner uses `-b practitioner-cookies.txt`.

## 4. Create a patient (as the practitioner)

Practitioners can only ever create **patient** accounts —
`UsersService.create` throws `403 Forbidden` ("Practitioners can only
create patient accounts") if a practitioner submits any other `role`. As
with the practitioner above, `clinicId` matters — it's what makes this
patient show up under "patients Dr. Smith manages."

```bash
curl -i -b practitioner-cookies.txt -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{
    "email": "patient1@example.com",
    "password": "patient-password-1",
    "role": "patient",
    "firstName": "Sam",
    "lastName": "Rivera",
    "dateOfBirth": "1990-04-12",
    "clinicId": 1
  }'
```

`→ 201 Created`. Note the response `id` — this is the `patientId` used
below.

## 5. Create an exercise (as the practitioner)

`POST /exercises` is `@Roles('practitioner')` **only** — not admin (admins
can edit and archive existing exercises, but not author new ones; see
[Authorization](./04-authorization.md)). `primaryMuscles` and `instructions`
are both required, non-empty arrays.

```bash
curl -i -b practitioner-cookies.txt -X POST http://localhost:3000/exercises \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Standing Hamstring Stretch",
    "primaryMuscles": ["hamstrings"],
    "secondaryMuscles": ["calves"],
    "equipment": [],
    "instructions": [
      "Stand tall with one heel resting on a low step, leg straight.",
      "Hinge forward gently from the hips until a stretch is felt.",
      "Hold for 30 seconds, then switch legs."
    ]
  }'
```

`→ 201 Created`

```json
{
  "id": 1,
  "name": "Standing Hamstring Stretch",
  "primaryMuscles": ["hamstrings"],
  "secondaryMuscles": ["calves"],
  "equipment": [],
  "instructions": ["Stand tall...", "Hinge forward...", "Hold for 30 seconds..."],
  "mediaUrls": [],
  "source": "custom",
  "createdBy": 2,
  "isArchived": false
}
```

Keep `id: 1` (the exercise id) for the next step.

## 6. Assign a program to the patient (as the practitioner)

`POST /assigned-programs` — `@Roles('practitioner')` only, and
service-scoped to patients this practitioner manages
(`isPatientManagedBy`). You can either base it on an existing program
template (`basedOnTemplateId`) or, as here, supply an inline `exercises`
array directly. Each exercise needs at least `exerciseId` and `sortOrder`;
`sets`/`reps`/`durationInSeconds`/`notes` are all optional.

```bash
curl -i -b practitioner-cookies.txt -X POST http://localhost:3000/assigned-programs \
  -H "Content-Type: application/json" \
  -d '{
    "patientId": 3,
    "title": "Week 1 — Post-Op Knee Recovery",
    "startDate": "2026-08-06",
    "exercises": [
      {
        "exerciseId": 1,
        "sets": 3,
        "reps": 10,
        "sortOrder": 0,
        "notes": "Stop if sharp pain occurs — mild stretch tension only."
      }
    ]
  }'
```

`→ 201 Created` — the assigned program, with its copied exercise rows
attached under `exercises`. From this point, these rows are entirely
independent of the exercise/template they were copied from; later edits to
the exercise itself never retroactively change what's prescribed here.

## Where to go from here

- The patient can now log in (`POST /auth/login` with their own
  credentials) and see this program via `GET /assigned-programs` (scoped
  automatically to their own patient id — no query param needed).
- To let the patient actually perform it, they call `POST /sessions` with
  `{ assignedProgramId }` — see [Authorization](./04-authorization.md) for
  why this is patient-only, no exceptions.
- For everything not covered here — full field lists, optional fields,
  validation constraints on every DTO — check `/api-docs`. This walkthrough
  is intentionally minimal; the Swagger UI is the exhaustive reference.
- For real-time messaging between this practitioner and patient, see the
  [WebSocket API](./02-websocket-api.md) — a conversation must be created
  first via `POST /conversations` (clinic-scoped the same way assigning a
  program is) before either side can send messages.
