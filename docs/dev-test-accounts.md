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
| `sam@stride.test` | practitioner | Riverside | Same clinic as Alex, but on the care team of Jo, Robin and Frank only — the directory-vs-clinical split: **Add patient** finds Pat in the clinic directory, but Pat's page says Sam isn't on the care team. (Frank is `former.patient@`, deactivated.) |
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
  mixing Alex's exercises with library ones. The knee template has **two
  workouts** — *A · Mobility* and *B · Strength* — each exercise in one of
  them; the back template is a single workout, the shape every template had
  before workouts existed.
- **Assigned programs**, one of each schedule type, each with a history of
  completed sessions (on past days, so their summaries have something to
  show — today's session is left for you):
  - *Knee Rehab — Pat*, a copy of the knee template by Alex (both workouts
    copied with it), started **21 days before** the seed ran — three whole
    program weeks. Its schedule names a workout for each day: **Monday and
    Friday = A · Mobility, Wednesday = B · Strength**. Every scheduled day so
    far is done — each session with that day's workout — except:
    - week 1: the 2nd scheduled day, **made up** the next day (with the
      missed day's workout);
    - week 2: the 4th, **missed**, and the 5th, **done early** — on the free
      day before it, a session saying it counts for that day (`countsFor`);
    - week 3: a **swap** — the first two scheduled days doing different
      workouts exchange them, each session counting for the other day.
  - *Lower Back Mobility — Jo*, assigned by **Sam**, started **10 days
    before** the seed ran, **3 times a week** — so its program weeks start
    on the weekday it started, not on Monday. The template has a single
    workout, so every session is A. First program week: **2 of 3, missed**;
    second week: **1 so far, in progress** (the seed runs on its 4th day).
  - *Knee Rehab — Robin*, assigned by **Sam**, started **21 days before**
    the seed ran, **twice a week** (A, then B): two weeks done, then
    nothing — and **cancelled** on the day the seed ran. It had sessions, so
    it stays, read-only, ending the day before. *Knee Rehab — Robin, block
    2* **continues it** ("Assign again"): its workouts and exercises copied
    from the cancelled one, starting the day the seed ran.
  - No program is paused; to try a pause, add a schedule version of type
    `paused` from today (and another one later to resume).
