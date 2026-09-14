# Getting Started — A Real Walkthrough

A complete, working sequence: bootstrap a clinic, create a practitioner and a
patient, create an exercise, and assign a program to that patient. Every
request body below was checked against the actual DTO validation rules in
`src/**/dto/*.dto.ts` — field names, required-vs-optional, and enum values
are all real, not illustrative, and every response shape shown was derived
from the service code that builds it (not guessed).

These examples use `curl` with an explicit cookie jar (`-c`/`-b`) to make
session persistence across calls visible — a real frontend instead relies on
the browser handling the `connect.sid` cookie automatically via
`fetch(url, { credentials: 'include' })`. A `fetch` equivalent is shown for
the first call as a reference; every later step follows the same pattern
with `credentials: 'include'`.

Assume the API is running at `http://localhost:3000` (the local default;
adjust for your environment).

## 1. Register the clinic + founding admin

`POST /auth/register-clinic` only works **once** — before any admin account
exists anywhere in the system (see [Authentication](./01-authentication.md)).
It creates the clinic and its first admin together, in one transaction, and
logs that admin in immediately.

```bash
curl -i -c cookies-admin.txt -X POST http://localhost:3000/auth/register-clinic \
  -H "Content-Type: application/json" \
  -d '{
    "clinicName": "Riverside Physiotherapy",
    "clinicEmail": "contact@riverside-physio.example",
    "clinicPhone": "555-0100",
    "clinicAddress": "500 Riverside Blvd, Springfield",
    "email": "admin@riverside-physio.example",
    "password": "correct-horse-battery-staple",
    "firstName": "Alex",
    "lastName": "Chen",
    "phone": "555-0142",
    "address": "123 Main St, Springfield",
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
    clinicAddress: '500 Riverside Blvd, Springfield',
    email: 'admin@riverside-physio.example',
    password: 'correct-horse-battery-staple',
    firstName: 'Alex',
    lastName: 'Chen',
    phone: '555-0142',
    address: '123 Main St, Springfield',
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
  "phone": "555-0142",
  "address": "123 Main St, Springfield",
  "avatarPath": null,
  "isActive": true,
  "createdAt": "2026-08-05T14:00:00.000Z",
  "mfaEnabled": false,
  "roles": ["admin"],
  "activeRole": "admin",
  "adminProfile": { "position": "Clinic Director" },
  "clinicId": 1
}
```

The `connect.sid` session cookie from this response is now stored in
`cookies-admin.txt` — every subsequent call as the admin needs
`-b cookies-admin.txt`. Keep `clinicId: 1` handy; it's needed below.

## 2. Create a practitioner (as the admin)

`POST /users` accepts `@Roles(UserRole.PRACTITIONER, UserRole.ADMIN)`, so the
logged-in admin can call it. `role: "practitioner"` makes `licenseNumber`
required (`CreateUserDto`'s `@ValidateIf` only requires/validates it when
`role === 'practitioner'`). Pass `clinicId` — without a real
`user_clinics` link, every clinic-scoped check used elsewhere in this API
("which patients does this practitioner manage") will never find a match for
this account.

```bash
curl -i -b cookies-admin.txt -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{
    "email": "dr.smith@riverside-physio.example",
    "password": "another-strong-password-1",
    "role": "practitioner",
    "firstName": "Jordan",
    "lastName": "Smith",
    "phone": "555-0157",
    "address": "48 Elm St, Springfield",
    "licenseNumber": "PT-2024-00931",
    "specialties": ["sports rehab", "post-surgical"],
    "bio": "Sports physiotherapist focused on return-to-play rehab.",
    "clinicId": 1
  }'
```

`→ 201 Created` — the new practitioner's account, with `phone: "555-0157"`
and `address: "48 Elm St, Springfield"` alongside the usual top-level fields,
plus `roles: ["practitioner"]` and `practitionerProfile: { "licenseNumber":
"PT-2024-00931", "specialties": ["sports rehab", "post-surgical"], "bio":
"Sports physiotherapist focused on return-to-play rehab." }`
(`UsersService.create`'s response shape, with `bio` attached by
`UsersService.attachProfile()`). This call does **not** log the new
practitioner in — `POST /users` never touches the calling admin's session,
unlike the `/auth/*` routes (`register`, `register-clinic`, `login`), which
establish a session for the account they create or authenticate. The admin
stays logged in as the admin; the practitioner needs their own
`POST /auth/login` (step 3) before anything they do counts as coming from
them.

## 3. Log in as the practitioner

The practitioner account has exactly one role, so `role` can be omitted from
the login body entirely — see [Authentication](./01-authentication.md) for
what happens on a multi-role account.

```bash
curl -i -c cookies-practitioner.txt -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "dr.smith@riverside-physio.example",
    "password": "another-strong-password-1"
  }'
```

`→ 201 Created` with the practitioner's user object (`activeRole:
"practitioner"`, `phone: "555-0157"`, `address: "48 Elm St, Springfield"`,
`practitionerProfile: { licenseNumber, specialties, bio }`).
From here on, every call as the practitioner uses
`-b cookies-practitioner.txt`.

## 4. Create a patient (as the practitioner)

Practitioners can only ever create **patient** accounts —
`UsersService.create` throws `403 Forbidden`
(`"Practitioners can only create patient accounts"`) if a practitioner
submits any other `role`. As with the practitioner above, `clinicId` matters
— it's what makes this patient show up as one Dr. Smith manages.

```bash
curl -i -b cookies-practitioner.txt -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{
    "email": "patient1@example.com",
    "password": "patient-password-1",
    "role": "patient",
    "firstName": "Sam",
    "lastName": "Rivera",
    "phone": "555-0163",
    "address": "77 Oak Ave, Springfield",
    "dateOfBirth": "1990-04-12",
    "clinicId": 1
  }'
```

`→ 201 Created`, with `phone: "555-0163"` and `address: "77 Oak Ave,
Springfield"` alongside the usual top-level fields, and `patientProfile: {
"dateOfBirth": "1990-04-12" }` on the response. Note the response `id` —
this is the `patientId` used below (assume it's `3`: `1` was the admin,
`2` the practitioner).

## 5. Create an exercise (as the practitioner)

`POST /exercises` carries `@Roles(UserRole.PRACTITIONER)` **only** — not
admin. Admins can edit and archive existing exercises but cannot author new
ones (see [Roles & Authorization](./04-authorization.md)). `primaryMuscles`
and `instructions` are both required, non-empty arrays
(`CreateExerciseDto`); `secondaryMuscles` and `equipment` are optional and
default to an empty array server-side if omitted.

```bash
curl -i -b cookies-practitioner.txt -X POST http://localhost:3000/exercises \
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
  "instructions": [
    "Stand tall with one heel resting on a low step, leg straight.",
    "Hinge forward gently from the hips until a stretch is felt.",
    "Hold for 30 seconds, then switch legs."
  ],
  "mediaUrls": [],
  "source": "custom",
  "createdBy": 2,
  "isArchived": false
}
```

Keep `id: 1` (the exercise id) for the next step.

## 6. Assign a program to the patient (as the practitioner)

`POST /assigned-programs` carries `@Roles(UserRole.PRACTITIONER)` only, and
is additionally scoped in the service to patients this practitioner actually
manages (`isPatientManagedBy`). Provide **either** `basedOnTemplateId` (the
server copies that template's current exercises) **or** an inline
`exercises` array, as below — `AssignedProgramsService` requires one of the
two. Each inline exercise needs at least `exerciseId` and `sortOrder`
(`AssignedExerciseInputDto`); `sets`/`reps`/`durationInSeconds`/`notes` are
all optional.

```bash
curl -i -b cookies-practitioner.txt -X POST http://localhost:3000/assigned-programs \
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
attached under `exercises`. From this point these rows are entirely
independent of the exercise they were copied from; a later edit to the
exercise itself never retroactively changes what's prescribed here.

## Where to go from here

- The patient can log in (`POST /auth/login` with their own credentials) and
  see this program via `GET /assigned-programs` — automatically scoped to
  their own patient id, no query parameter needed.
- To actually perform it, the patient calls `POST /sessions` with
  `{ "assignedProgramId": <id> }` — see
  [Roles & Authorization](./04-authorization.md) for why this route is
  patient-only, with no practitioner or admin override anywhere in the
  chain.
- For real-time messaging between this practitioner and patient, see the
  [WebSocket API](./02-websocket-api.md) — a conversation must be created
  first via `POST /conversations` (clinic-scoped the same way assigning a
  program is) before either side can send messages, over REST or the
  socket.
- For every field, optional parameter, and validation constraint not shown
  here, check `/api-docs` — it's generated directly from the DTOs and stays
  in sync with the code by construction. This walkthrough is intentionally
  minimal; the Swagger UI is the exhaustive reference.
