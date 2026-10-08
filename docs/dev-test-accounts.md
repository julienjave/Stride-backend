# Demo data: accounts and what to try

`npm run seed:dev` fills your **development** database with two clinics, an
account for every role, one account per invitation state, and some content to
look at. Everything below is created by that command; the data itself lives in
`scripts/seed/dataset.ts` (a test, `scripts/seed/dataset.spec.ts`, checks this
page still matches it).

These are demo accounts with a published password. They are for local
development and reviewing only — the seed refuses to run with
`NODE_ENV=production`.

## Running it

With the services up (`docker compose up -d`), migrations applied
(`npx drizzle-kit migrate`) and the app role created
(`npm run db:create-app-role`):

| Command | What it does |
| --- | --- |
| `npm run seed:exercises` | Imports the shared exercise library (downloads ~870 exercises and their photos — a few minutes; needs internet). Safe to re-run: existing exercises are skipped. |
| `npm run seed:dev` | Creates the accounts and content below. Refuses a database that already has users. |
| `npm run seed:dev -- --reset` | Deletes every user, clinic and everything that belongs to them first — **the exercise library is kept** — then seeds again. |
| `npm run seed` | Both: the library, then the accounts. Add `-- --reset` to reset the accounts. |

The seed never touches a database whose name ends in `_test` (the e2e tests'
own). Run the library import first if you want the templates complete: without
it, they're created with only Alex's own exercises (the seed says which ones it
skipped).

Invitation emails go through your configured transport. With
`EMAIL_TRANSPORT=smtp` and Mailpit running, open **<http://localhost:8025>** to
read them.

## Password

Every account that has a password uses: **`password123`**

## Clinics

- **Riverside Physio** — Alex, Sam, Morgan, and most patients.
- **Harbour Sports Clinic** — Blake; Robin and the admin belong to both.

## Accounts you can log in with

| Email | Role(s) | Clinic(s) | What it shows |
| --- | --- | --- | --- |
| `admin@stride.test` | admin | both | The founding admin: clinics, users, and each user's invitation status (Admin → Users → a user). |
| `morgan@stride.test` | practitioner + admin | Riverside | The role switcher in the account menu. Logging in asks which role to use. |
| `alex@stride.test` | practitioner | Riverside | A practitioner with patients: two custom exercises in the library, two templates, and a program assigned to Pat (Programs page: *Templates* and *Assigned* tabs). |
| `sam@stride.test` | practitioner | Riverside | Same clinic as Alex, but on the care team of Jo, Robin and Frank only — the directory-vs-clinical split. Visible once the patient roster ships; it's in the data and the API today. |
| `blake@stride.test` | practitioner | Harbour | Another clinic: shares just Robin with Riverside. |
| `pat@stride.test` | patient | Riverside | Alex's patient, with an assigned program (the patient's own screens come in Phase 4). |
| `jo@stride.test` | patient | Riverside | A care team of two: Alex and Sam. |
| `robin@stride.test` | patient | both | In both clinics, with a care team in each: Sam and Blake. |

## Accounts that show invitation states

These can't log in (no password yet, or deactivated). Look at them as the admin:
**Admin → Users →** the account, section **Invitation**. The deactivated one is
listed once you tick **Show deactivated users**.

| Email | State | What to try |
| --- | --- | --- |
| `new.patient@stride.test` | invitation pending, email sent | Its email is in Mailpit: open it, follow the link, choose a password, then log in. |
| `stuck.patient@stride.test` | invitation pending, email couldn't be sent | The amber warning. "Send again" emails a new link (to Mailpit). |
| `late.patient@stride.test` | invitation expired | "Send a new invitation". |
| `former.patient@stride.test` | deactivated | A former patient (password `password123`, but deactivated): logging in fails; the admin can reactivate the account. |

The seed prints one error while it runs — the failed email for
`stuck.patient@stride.test`. That failure is on purpose (it's how that state is
made, through the app's own code); the seed announces it just before.

## Content

- **Alex's exercises:** *Terminal Knee Extension (band)* and *Heel Slides*.
- **Alex's templates:** *Knee Rehab — Phase 1* and *Lower Back Mobility*,
  mixing Alex's exercises with library ones.
- **Assigned program:** *Knee Rehab — Pat*, a copy of the knee template,
  starting the day the seed ran.
