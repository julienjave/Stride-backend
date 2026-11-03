# Getting Started — A Real Walkthrough

From an empty database to a patient seeing the program their practitioner
assigned, in eight steps, with `curl`. Every request and every answer below
comes from **one real run** against a local backend (3 November 2026). The
answers are trimmed to the fields that matter here, with `jq`, the same way
the run printed them.

What it shows, in order: setting up Stride, inviting people (there is no
sign-up), signing in with a session cookie, the practitioner–patient link
that every later permission hangs on, and the shape of an assigned program.

## Before you start

- A backend running locally against a **fresh database**: migrated, with
  the restricted app role created, and **not seeded**. The seed creates
  accounts, after which step 1 is closed. The setup is in
  [`DEPLOYMENT.md`](../DEPLOYMENT.md), part 1. To explore with ready-made
  accounts instead, seed the database and use those in
  [`demo-accounts.md`](../demo-accounts.md).
- **Mailpit** running (it's in `docker-compose.yml`), with
  `EMAIL_TRANSPORT=smtp`, as in `.env.example`. The invitations of steps 3
  and 8 are real emails. Mailpit catches them: its inbox is at
  http://localhost:8025, and the walkthrough reads it through Mailpit's API.
- `curl` and `jq`.

Cookies: each person gets a cookie file (`-c` writes it at sign-in, `-b`
sends it), the way a browser keeps one cookie jar per site.

```bash
API=http://localhost:3000
MAIL=http://localhost:8025
J='Content-Type: application/json'
```

## 0. Is Stride set up?

```bash
curl -s $API/auth/setup-status
```

```json
{"setupComplete":false,"demo":null}
```

`false`: no admin exists yet, so the one-time setup route is open.

## 1. Register the clinic and its founding admin

```bash
curl -s -c admin.txt -X POST $API/auth/register-clinic -H "$J" -d '{
  "clinicName": "Riverside Physiotherapy",
  "clinicEmail": "hello@riverside.example",
  "email": "admin@riverside.example",
  "password": "correct-horse-battery",
  "firstName": "Ada",
  "lastName": "Admin"
}'
```

```json
{
  "id": 1,
  "email": "admin@riverside.example",
  "roles": ["admin"],
  "activeRole": "admin",
  "clinicId": 1
}
```

`201`, and Ada is **signed in**: the answer set the session cookie, now in
`admin.txt`. Keep `clinicId`; the next steps need it. From now on this
route answers `403`, and `setupComplete` is `true`.

## 2. Create a practitioner (as the admin)

```bash
curl -s -b admin.txt -X POST $API/users -H "$J" -d '{
  "email": "alex@riverside.example",
  "role": "practitioner",
  "firstName": "Alex",
  "lastName": "Moreau",
  "licenseNumber": "PT-48213",
  "clinicId": 1
}'
```

```json
{
  "id": 2,
  "email": "alex@riverside.example",
  "roles": ["practitioner"],
  "invitation": {
    "id": 1,
    "status": "pending",
    "expiresAt": "2026-11-10T09:22:23.986Z",
    "emailSent": true
  }
}
```

There's **no `password` field**; sending one is a `400` (unknown fields
are refused). Alex's account exists, but without a password. Alex chooses
it from the invitation email, valid for 7 days. `emailSent: false` would
mean the account exists but the email failed; `POST
/users/:id/invitations` sends a new one.

## 3. Accept the invitation

The email holds a link to the frontend's accept page,
`…/accept-invitation?token=…`. Here the token is read from Mailpit:

```bash
id=$(curl -s "$MAIL/api/v1/search?query=to:alex@riverside.example" | jq -r '.messages[0].ID')
TOKEN=$(curl -s "$MAIL/api/v1/message/$id" | jq -r '.Text' | grep -oE 'token=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)
```

What the accept page shows first:

```bash
curl -s -X POST $API/invitations/lookup -H "$J" -d "{\"token\":\"$TOKEN\"}"
```

```json
{
  "email": "alex@riverside.example",
  "firstName": "Alex",
  "lastName": "Moreau",
  "clinicNames": ["Riverside Physiotherapy"],
  "expiresAt": "2026-11-10T09:22:23.986Z"
}
```

Then Alex chooses a password:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/invitations/accept -H "$J" \
  -d "{\"token\":\"$TOKEN\",\"password\":\"practitioner-pass-1\"}"
```

```
204
```

The token goes in the **body**, never in an API URL, because URLs end up
in logs. The invitation is now used up: a second `accept` answers `410`
with `reason: "accepted"`.

## 4. Sign in as the practitioner

```bash
curl -s -c alex.txt -X POST $API/auth/login -H "$J" \
  -d '{"email":"alex@riverside.example","password":"practitioner-pass-1"}'
```

```json
{
  "id": 2,
  "roles": ["practitioner"],
  "activeRole": "practitioner",
  "practitionerProfile": { "licenseNumber": "PT-48213", "specialties": [], "bio": null }
}
```

`201`, not `200`: a `POST` without `@HttpCode`
([why](./01-authentication.md#a-nest-default-worth-knowing-post-answers-201)).
One role, so no `role` field was needed. An account with two-factor
sign-in on would get `{ "mfaRequired": true }` here, then send its code to
`POST /auth/mfa/verify`.

## 5. Create a patient (as the practitioner)

```bash
curl -s -b alex.txt -X POST $API/users -H "$J" -d '{
  "email": "pat@riverside.example",
  "role": "patient",
  "firstName": "Pat",
  "lastName": "Lee",
  "dateOfBirth": "1988-04-12",
  "clinicId": 1
}'
```

```json
{
  "id": 3,
  "email": "pat@riverside.example",
  "roles": ["patient"],
  "patientProfile": { "dateOfBirth": "1988-04-12" },
  "invitation": { "id": 2, "status": "pending", "expiresAt": "2026-11-10T09:22:24.347Z", "emailSent": true }
}
```

This one step does more than it shows:

- **Alex joins Pat's care team.** That link (with the shared clinic) is
  what lets Alex see Pat at all, in the service checks and in the
  database's Row-Level Security. Another practitioner asking for Pat gets a
  `404`, as if Pat didn't exist.
- A practitioner may create **patients only**, and only in a clinic they
  belong to. `clinicId` is required; without it the answer is `400 Choose
  the clinic this patient belongs to`.
- If a patient with the same name and date of birth already exists, the
  answer is a `409` with `reason: "possible_duplicate"`. Send
  `allowPossibleDuplicate: true` to create anyway.

## 6. Create an exercise (as the practitioner)

```bash
curl -s -b alex.txt -X POST $API/exercises -H "$J" -d '{
  "name": "Seated knee extension",
  "primaryMuscles": ["quadriceps"],
  "equipment": ["chair"],
  "instructions": [
    "Sit tall on a chair, feet flat on the floor.",
    "Straighten one knee until the leg is level, hold for two seconds.",
    "Lower slowly. Repeat, then switch legs."
  ]
}'
```

```json
{ "id": 1, "name": "Seated knee extension", "source": "custom", "createdBy": 2 }
```

`source: "custom"` marks an exercise written in Stride, as opposed to the
imported library the seed loads (`npm run seed:exercises`). Photos are
added afterwards: `POST /exercises/:id/images`, multipart.

## 7. Assign a program to the patient (as the practitioner)

```bash
curl -s -b alex.txt -X POST $API/assigned-programs -H "$J" -d '{
  "patientId": 3,
  "title": "Knee strength, weeks 1-4",
  "startDate": "2026-11-03",
  "exercises": [
    { "exerciseId": 1, "sets": 3, "reps": 12, "sortOrder": 0 }
  ],
  "schedule": {
    "type": "weekdays",
    "days": [
      { "weekday": 1, "workoutIndex": 0 },
      { "weekday": 3, "workoutIndex": 0 },
      { "weekday": 5, "workoutIndex": 0 }
    ]
  }
}'
```

```json
{
  "id": 1,
  "title": "Knee strength, weeks 1-4",
  "status": "active",
  "startDate": "2026-11-03",
  "workouts": [{ "id": 1, "sortOrder": 0 }],
  "exercises": [
    { "id": 1, "workoutId": 1, "exerciseId": 1, "name": "Seated knee extension", "sets": 3, "reps": 12 }
  ],
  "schedules": [
    {
      "type": "weekdays",
      "effectiveFrom": "2026-11-03",
      "days": [
        { "weekday": 1, "workoutId": 1 },
        { "weekday": 3, "workoutId": 1 },
        { "weekday": 5, "workoutId": 1 }
      ]
    }
  ]
}
```

What the shape says:

- **A program is made of workouts.** Exercises sent at creation go into
  one workout. Further workouts (A, B, …) are added with
  `POST /assigned-programs/:id/workouts`, and exercises are placed in them.
- **The exercise is copied, not referenced.** The program's exercise row
  (`id: 1`) has its own `name`, `sets` and `reps`, copied from the library
  exercise (`exerciseId: 1`). Editing the library later doesn't change what
  Pat was prescribed. A health record must not change after the fact.
- **The schedule is versioned.** `schedules` is a list of versions, each
  with the date it takes effect (`effectiveFrom`). A change of plan adds a
  version (`POST /assigned-programs/:id/schedules`) instead of rewriting
  the past, so the sessions Pat already did keep the schedule they were
  done under. `weekday` is ISO: 1 = Monday … 7 = Sunday. The other kind
  at creation is `times_per_week` (with `timesPerWeek`, 1–7). A later
  version can also be `paused`.
- **Dates are calendar dates** (`YYYY-MM-DD`), with no time zone
  ([conventions](./03-conventions.md#dates-and-times)).

To start from a saved template instead, send `basedOnTemplateId` (from
`/programs`), or `basedOnProgramId` to copy one of the patient's earlier
programs.

## 8. The patient accepts, signs in, and sees the program

```bash
# Pat's invitation token, read from Mailpit as in step 3, then:
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/invitations/accept -H "$J" \
  -d "{\"token\":\"$TOKEN\",\"password\":\"patient-pass-1\"}"
curl -s -c pat.txt -X POST $API/auth/login -H "$J" \
  -d '{"email":"pat@riverside.example","password":"patient-pass-1"}'
curl -s -b pat.txt $API/assigned-programs
```

```
204
{ "id": 3, "activeRole": "patient" }
[ { "id": 1, "title": "Knee strength, weeks 1-4", "status": "active" } ]
```

The same route answers each role differently. For Pat, `GET
/assigned-programs` is *Pat's* programs. For Alex, it's the programs of
Alex's patients (`?patientId=3` narrows to one). For a patient outside
Alex's care team, it's nothing.

## Where to go from here

- **Sessions**: Pat starts a session from a program (`POST /sessions`),
  ticks off exercises, and finishes it. One finished session a day.
- **Messaging**: `POST /conversations` between Alex and Pat, then live
  over the [WebSocket](./02-websocket-api.md).
- **Every route**, with who may call it: the [endpoint index](./06-endpoints.md).
  Request bodies: Swagger at `/api-docs`.
- **Who may do what, and why**: [Roles & Authorization](./04-authorization.md).
