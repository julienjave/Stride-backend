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
| `admin@stride.test` | admin | both | The founding admin: clinics, users, and each user's invitation status (Admin → Users → a user). The home shows the **metrics**, who **needs attention** and the **recent activity** — see **The admin home** below. |
| `morgan@stride.test` | practitioner + admin | Riverside | The role switcher in the account menu. Logging in asks which role to use. |
| `alex@stride.test` | practitioner | Riverside | A practitioner with patients: two custom exercises in the library, two templates, and a program assigned to Pat (Programs page: *Templates* and *Assigned* tabs). |
| `sam@stride.test` | practitioner | Riverside | Same clinic as Alex, but on the care team of Jo, Robin and Frank only — the directory-vs-clinical split: **Add patient** finds Pat in the clinic directory, but Pat's page says Sam isn't on the care team. (Frank is `former.patient@`, deactivated.) Sam also LEFT Dana's care team. |
| `blake@stride.test` | practitioner | Harbour | Another clinic: shares just Robin with Riverside. |
| `pat@stride.test` | patient | Riverside | Alex's patient, with an assigned program (the patient's own screens come in Phase 4). |
| `jo@stride.test` | patient | Riverside | A care team of two: Alex and Sam. |
| `robin@stride.test` | patient | both | In both clinics, with a care team in each: Sam and Blake. |
| `casey@stride.test` | patient | Riverside | Two-factor sign-in on: logging in asks for a code — see **Two-factor sign-in** below. |
| `dana@stride.test` | patient | Riverside | Created by Sam, who then **left her care team**: nobody treats her. On the admin home's **Needs attention**; her **Team** page shows Sam as a past member. |
| `taylor@stride.test` | practitioner | none | Created at Harbour, then **removed from it** by the admin: in no clinic, so on nobody's directory. On the admin home's **Needs attention**. |

## The admin home

Log in as `admin@stride.test`. Under the shortcuts:

- **Metrics** — active accounts by role (an account with two roles counts in
  each), clinics, and invitations still waiting; deactivated ones are counted
  apart.
- **Needs attention** — three groups, each name a link to the user page where
  the fix is:
  - **Patients without a care team:** Dana (Sam left). Fix it on her user
    page: **Care team → Add someone**.
  - **Practitioners without a clinic:** Taylor (removed from Harbour). Fix it
    on their user page: **Clinics → Add**.
  - **Invitations to send again:** Lena Late (her invitation expired) and Stu
    Waiting (its email couldn't be sent) — they can't join on their own. Fix it
    on their user page: **Invitation → Send a new invitation** / **Send
    again**. (A revoked invitation isn't listed: someone decided it.)
  The group's title and "and N more" lead to the users list filtered the same
  way (**Show:** at the top of Admin → Users).
- **The users list** (**Admin → Users**) has a **Search** (part of a name, or
  of an email), **Role**, **Clinic** (one, or **No clinic**), **Status**
  (active, deactivated, or all) and the **Show** groups above; they combine,
  live in the address (Back and a shared link keep them), and the list comes
  25 accounts a page. Try **Role: Practitioners**, then **Clinic: Harbour
  Sports Clinic**, then Back.
- **The numbers keep themselves current:** above **Metrics**, "Updated … ·
  refreshes every minute" and a **Refresh** button. Leave the home open and
  create a user in another tab — within a minute the numbers and Recent
  activity include it.
- **Recent activity** — the newest changes from the audit log, with **See all
  changes**.
- **Deactivating a practitioner ends their care-team links** — try it on
  **Admin → Users → Alex Chen → Deactivate user** (the dialog says so). Alex's
  six links end: each patient's care team shows Alex as a past member, and Pat,
  Casey and the invited patients join **Patients without a care team** (Jo
  still has Sam). Reactivating Alex brings none of them back. A deactivated
  **patient** keeps their care team: log in as `sam@stride.test` and open
  Frank (`former.patient@`) — the page says **Account deactivated**, still
  shows his record and his care team, and Sam can still leave it; nobody new
  can join until the account is reactivated (the admin sees the same on
  **Admin → Users → Frank Former**, with **End**). Sam finds Frank under
  **Patients → Show 1 deactivated patient**; his page offers no **Message**
  and no **Assign a program** — the notice says why — and any program of his
  can only be completed or cancelled. Run `npm run seed:dev -- --reset`
  afterwards.

## Two-factor sign-in

`casey@stride.test` has two-factor sign-in on. After the password, the sign-in
asks for a code — two ways to get one:

- **An authenticator app** (Google Authenticator, Microsoft Authenticator,
  1Password…): add an account **by hand** (not by scanning) with the key
  **`STRIDEDEMOTWOFACTORSTRIDEDEMOTWO`** — time-based, 6 digits, every 30 seconds (the apps' default).
  The app then shows Casey's current code.
- **A recovery code**: each works **once** (until the next `npm run seed:dev --
  --reset`): `strde-22222`, `strde-33333`, `strde-44444`, `strde-55555`, `strde-66666`, `strde-77777`, `strde-88888`, `strde-99999`, `strde-aaaaa`, `strde-bbbbb`.

Then try, as Casey: **Profile → Two-factor sign-in → Manage** (the codes left,
new codes, turning it off), or a password change, which asks a code too. As the
admin: **Admin → Users → Casey Moreau**, section **Two-factor sign-in** — the
reset, for someone who lost their phone and their codes.

Any other account can set it up from its own profile: **Profile → Two-factor
sign-in → Set up**.

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

- **Practitioner profiles** (what a patient sees on **Team**): Morgan, Alex
  and Sam each have specialties and a short bio; Blake has specialties but no
  bio — log in as `robin@stride.test`, **Team → Blake Martin** to see a
  profile without one. Each patient's team: **Pat** — Alex; **Jo** — Alex and
  Sam; **Robin** — Sam (Riverside) and Blake (Harbour), each profile naming
  the clinic they share.
- **Alex's exercises:** *Terminal Knee Extension (band)* and *Heel Slides*.
- **Alex's templates:** *Knee Rehab — Phase 1* and *Lower Back Mobility*,
  mixing Alex's exercises with library ones. The knee template has **two
  workouts** — *A · Mobility* and *B · Strength* — each exercise in one of
  them; the back template is a single workout, the shape every template had
  before workouts existed.
- **Copying exercises** (as `alex@stride.test`): on the knee template — or
  Pat's knee program — the copy icon on a workout's header opens **Copy
  exercises from A · Mobility**: every exercise ticked, the next workout
  chosen, or **A new workout** with an optional name. One request copies them
  all, appended in the workout's order, with one audit entry (*Copied
  exercises within a template / program*). On a program the copies are the
  patient's own rows (tailored description, prescription, own photos copied
  to new files). The back template has one workout: **Copy to a new
  workout…** beside **Add a workout** duplicates it. Run `npm run seed:dev --
  --reset` afterwards.
- **Assigned programs**, one of each schedule type, each with a history of
  completed sessions (on past days, so their summaries have something to
  show — today's session is left for you):
  - *Knee Rehab — Pat*, a copy of the knee template by Alex (both workouts
    copied with it), started **21 days before** the seed ran — three whole
    program weeks. Its schedule names a workout for each day: **Monday and
    Friday = A · Mobility, Wednesday = B · Strength**. Every scheduled day so
    far is done — each session with that day's workout — except:
    - week 1: the 2nd scheduled day, **made up** the next day (with the
      missed day's workout) — and on that day itself, a session **stopped
      for pain** (pain 7/10 after, one exercise of two ticked): it shows as
      a label on the day, not as done;
    - week 2: the 4th, **missed** — and **skipped for illness** that
      morning (a label on the missed day: still missed) — and the 5th,
      **done early** — on the free day before it, a session saying it
      counts for that day (`countsFor`);
    - week 3: a **swap** — the first two scheduled days doing different
      workouts exchange them, each session counting for the other day.
    The summary's totals count them: **1 skipped, 1 incomplete**.
    **Pain and mobility** (the program page's charts, the home's trend):
    pain before easing from 6 to 3, pain after lower at each session,
    mobility rising from 4 to 7; the session stopped for pain: 5 before, 7
    after; the session done early answered the check-in only (a gap in the
    "after" line). Its **last session** rated its second exercise **9 of
    10**, with a note ("Sharp pain at the end of the movement. Should I stop
    earlier?") — a session on **Alex's To-do**.
  - *Lower Back Mobility — Jo*, assigned by **Sam**, started **17 days
    before** the seed ran, **3 times a week** — so its program weeks start
    on the weekday it started, not on Monday. The template has a single
    workout, so every session is A. First program week: **2 of 3, missed**;
    second week: **1 of 3, missed** — two weeks in a row below target, an
    **attendance alert** on Alex's and Sam's To-do; third week: **1 so far,
    in progress** (the seed runs on its 4th day). Its second session skipped
    the pain check-in (a gap in the "before" line).
  - *Knee Rehab — Robin*, assigned by **Sam**, started **21 days before**
    the seed ran, **twice a week** (A, then B): two weeks done, then
    nothing — and **cancelled** on the day the seed ran. It had sessions, so
    it stays, read-only, ending the day before. *Knee Rehab — Robin, block
    2* **continues it** ("Assign again"): its workouts and exercises copied
    from the cancelled one, starting the day the seed ran. Its sessions all
    made the pain **worse** (3→5, 4→5, 3→4, 3→7) — the gap between "before"
    and "after" the charts exist to show; look at it as **Sam**. The last
    one (pain 7 after, up 4) is a session to review, **already reviewed by
    Sam**: it is on **Blake's** To-do only, and its page shows Blake
    "Reviewed by Sam Okafor".
  - No program is paused; to try a pause, open a program as its
    practitioner (`alex@stride.test`, Pat's knee program) and choose
    **Pause** in **Schedule & progress**. **Back on** is optional: with a
    day, the schedule in force before the pause comes back on that day —
    both written at once (`POST …/schedules { type: 'paused', effectiveFrom,
    resumeOn }`), one entry in the audit log; without one, the pause stays
    open until **Resume**.
  - Admins read **no program and no session** (`admin@stride.test` gets a
    403; the database hides them too). The audit log still shows who did
    what, to whom and when — without a program's or a session's clinical
    details ("Clinical details aren't shown to admins").
- **The practitioners' "For review" list** (the home page, under the
  shortcuts; `GET /alerts`): **Alex** — Jo's two missed weeks, and Pat's last
  session (a hard exercise, a note); **Sam** — Jo's two missed weeks (Robin's
  session is reviewed); **Blake** — Robin's last session (high pain, a rise
  of 4). Morgan has none (on no care team). A session leaves the list when
  that practitioner marks it reviewed (its page), or 14 days after it
  happened. A program's alert clears itself when the patient acts, or when
  that practitioner marks it reviewed on the program page's banner — then it
  stays off their list until something changes, or for 14 days.
  **Care-team joins** (since 2026-10-28): when someone joins a patient's care
  team, or is added to it, the practitioners already on it see it here — so
  **Alex** also sees *Sam Okafor joined the care team* (Jo) and **Sam** sees
  *Blake Martin joined the care team* (Robin). **Mark as reviewed** in the row
  takes it off that practitioner's list; it leaves by itself after 14 days.
  To see an admin's addition: as the admin, add Morgan to Pat's care team
  (**Admin → Users → Pat → Care team → Add someone**) — Alex then sees *Avery
  Admin added Morgan Reyes to the care team*.
  **Complaint reviews** (since 2026-10-28): the seed opens none — to see one,
  as the admin go to **Admin → Users → Pat → Complaint reviews → Open a
  review**, give a reason (and a case reference if you like). For 7 days
  **Download a review copy** saves Pat's record as a PDF stamped *Review copy*
  on every page; each copy is in the audit log. **Alex** (on Pat's care team)
  then sees *Avery Admin opened a complaint review of the record* in For
  review — who, when, until, never the reason. Another admin (Morgan, as
  admin) sees the review and can **End now**, but can't make copies with it.
  **Legal disclosures** (since 2026-10-28): the seed makes none — to try one,
  as the admin go to **Admin → Users → Pat → Legal disclosures → Record a
  disclosure**: the recipient, the legal basis, the day the request arrived,
  the parts of the record (messages leave the app only this way) and, if you
  like, a period. **Record and download** saves ONE PDF, stamped *Disclosed to
  … under … on …* on every page; there is no second copy. Pat then finds it on
  **Profile → My records → When your record was shared**, and at the end of
  their own PDF copy; **Alex** sees *Avery Admin disclosed the record to …* in
  For review — who, when, to whom, never the order. Tick **Hold it back from
  Pat** (a day after today, and the agency's statement): Pat's list and copy
  leave it out until that day, and Alex's row says when Pat will see it.
- **Messages** (`GET /conversations`; the screens come with Phase 5's
  frontend): a patient writes with the practitioners on their care team, and
  only while they are on it.
  - **Pat ↔ Alex**: an exchange over the last few days. Alex's last two
    messages are **unread** — Pat's list shows 2 unread.
  - **Jo ↔ Sam**: Jo's question about a lighter program waits for Sam —
    **1 unread** on Sam's side.
  - **Robin ↔ Blake**: an old exchange that **Robin archived** (it shows
    behind "archived" on Robin's side only; a new message from either side
    brings it back for both).
  - Admins have **no messaging** — no route, no conversation, no message
    (`admin@stride.test` gets a 403; the database hides them too).
  - **Opening a thread is recorded:** when a practitioner opens a patient's
    conversation, the audit log gets **Viewed messages** about that patient
    (`MESSAGES_VIEWED`, the ids of the messages shown, never their text — one
    entry per page, "load earlier" included). Log in as `alex@stride.test`,
    open **Messages → Pat Lee**, then as the admin look at **Audit log**,
    **Kind: Views**. A patient reading their own messages isn't recorded.
  - **"You have a new message" emails:** a message left unread for 15
    minutes (the sender's delete window) emails its recipient — who wrote,
    never the text — once per conversation until it's read. The running
    backend checks every minute, so right after `seed:dev` the seeded unread
    messages produce two emails in Mailpit within a minute or so: **Pat**
    (from Alex) and **Sam** (from Jo). Reading the thread lets the next new
    message email again. Each person turns them off in **Settings** (the gear)
    → **Email me about new messages**. (The e2e suites and the seed never send
    them: only the running server starts the check.)
  - To see a **read-only** conversation: as the admin, end Alex's place on
    Pat's care team (Admin → Users → Pat → Care team → End). Pat and Alex
    both still read their history; neither can write until Alex rejoins.
  - A message can be deleted by its sender while it is **unread and at most
    15 minutes old** — the seeded ones are all older; send a new one to try.
- **Medical files** (`GET /medical-files`; the screens come with Phase 6's
  frontend): each entry is a SOAP note — Subjective, Objective, Assessment,
  Plan — written by a practitioner on the patient's care team. Entries are
  never edited or deleted; a correction is an **amendment** (a new entry that
  points at the old one, with a reason), and the old one stays, marked as
  amended.
  - **Pat** (by Alex): an initial assessment the day the knee program
    started; a progress note 11 days ago that recorded the **wrong knee**,
    **amended** the same morning ("The wrong knee was recorded…"); and a short
    note from yesterday with only Subjective and Plan.
  - **Jo** (by Sam): an initial assessment when the back program started.
  - **Robin**: an initial assessment by Sam (Riverside), a **discharge
    summary** by Sam when the first block was cancelled, and a progress note
    by Blake (Harbour).
  - Admins read **no medical file** (`admin@stride.test` gets a 403; the
    database hides the rows too). Every read is in the audit log —
    `MEDICAL_FILE_VIEWED` (the list, with the entries shown) and
    `MEDICAL_FILE_ENTRY_VIEWED` (one entry) — including a patient reading
    their own.

## Possible duplicate patients

Creating a patient whose **date of birth and name** match an existing patient's
(ignoring case, accents, hyphens and spaces, or with first and last name
swapped) shows a warning instead of creating the account straight away. Two
real people can share both, so it is never a refusal.

- **As a practitioner, a match in your clinics:** log in as `sam@stride.test`,
  **Patients → Add patient → Invite a new patient**: **Pat Lee**, born
  **1988-04-12**, any new email. Pat is shown as a patient of your clinic with **Add to my patients**
  (the better answer, if it's the same person). "pat lee", "LEE / Pat" or
  "Pát Lee" match too.
- **As a practitioner, a match you can't see:** still as Sam, invite **Frank
  Former**, born **1958-08-08**. Frank is deactivated, so Sam only reads that
  an account exists that he can't see — check with an admin — then **Invite
  Frank Former anyway**.
- **As the admin:** `admin@stride.test`, **Admin → Users → Add a user**, a
  patient **Frank Former**, born 1958-08-08. Every match is listed — Frank,
  "· Deactivated", Riverside Physio — each opening in a new tab.
  **Create Frank Former anyway** goes through, and the audit log's entry says
  **Possible duplicate of (user ids)**. Granting the patient role to an
  existing account (**Admin → Users →** an account **→ Grant a role**) warns
  the same way.

Run `npm run seed:dev -- --reset` afterwards to remove the extra accounts.

## Merging duplicate patients

When one patient ends up with two accounts, an admin merges them: everything
of one account (programs, sessions, medical file, messages, care team) moves
to the other, and the emptied account is deactivated for good.

1. Make a second account for Pat: as `admin@stride.test`, **Admin → Users →
   Add user**, a patient **Pat Lee**, born **1988-04-12**, any new email, then
   **Create Pat Lee anyway**.
2. Open that new account's page and choose **Merge with another account…**
   (section **Duplicate account**). Pick Pat's account (`pat@stride.test`) in
   **The other account**: the two show side by side, with what differs said
   above them.
3. Choose **Keep Pat Lee (pat@stride.test)**, read what will happen, enter
   your password (`password123`), then **Merge the accounts**.
4. The merged account's page now says **Merged into Pat Lee** and offers
   nothing else; the users list (tick **Show deactivated users**) marks it
   **Merged**. Pat gets an email (Mailpit) saying the accounts were combined,
   and the audit log has **Merged two accounts of a patient**.
5. Log in as `alex@stride.test` (on Pat's care team): **For review** shows
   *Avery Admin merged a second account of this patient into this one*, with
   **Mark as reviewed** and **Open patient**.

A merged account can't be reactivated, and merging asks for the admin's
password every time (and a code, with two-factor sign-in on). Run
`npm run seed:dev -- --reset` afterwards.

## Health record copies

A patient's whole record — medical file, programs and sessions — as one PDF,
made on request and never stored. Two ways to get one:

- **The patient's own download:** log in as `pat@stride.test`, **Profile → My
  records → Download my records**. The file is named after today's date; its
  dates are written in your browser's time zone. Five copies a minute, then
  the page says how long to wait.
- **An emailed link, for a patient who can't sign in:** as `admin@stride.test`,
  **Admin → Users → Frank Former** (`former.patient@stride.test`, deactivated —
  list deactivated users with the filter at the top of the list), section
  **Health record copy → Email a download link**. Open the email in Mailpit
  and follow its link (signed in or not — it works either way). The page asks
  Frank's date of birth (it's on his user page) before the download. A link
  works **once**, for **72 hours**; **5 wrong dates** lock it; a new link
  replaces the open one. The user page lists every link and what became of
  it; the audit log shows *Emailed a health record download link*, *Entered a
  wrong date of birth on a download link* and *Downloaded a copy of a health
  record*.
