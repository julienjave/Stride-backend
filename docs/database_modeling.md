# 1. Architectural Strategy & Design Refinements

### The "All Users in One Table" Pattern (Recommended)
Instead of creating separate tables for `practitioners`, `patients`, and `administrators`, create a single unified `users` table, and use a `role` enum (`'admin'`, `'practitioner'`, `'patient'`).

- **Why?** It streamlines authentication, password hashing, and session management into a single point. It also handles your Direct Messaging perfectly—messages just connect a `sender_id` to a `receiver_id` in the `users` table, regardless of their role.

- You can use a `profiles` table or a `JSONB` column on the user table to store role-specific metadata (like a practitioner's license number vs. a patient's emergency contact).

### The Tracking System: One Big Log vs. Multiple Tables
For absolute immutability and regulatory compliance, use one centralized `audit_logs` table.

- **Why?** Splitting it makes it incredibly difficult to generate an application-wide security timeline. A single, append-only ledger is easy to secure.

- You can use a `JSONB` payload column to capture the context of the action.


# 2. Proposed Database Schema Design

Here is a structured relational blueprint utilizing `JSONB` for flexibility where medical or exercise data can change rapidly.

## 1. Core Core Systems & Users

### `clinics`
Stores global tenant or customization info.

- `id` (SERIAL PRIMARY KEY)
- `name` (VARCHAR NOT NULL)
- `email` (VARCHAR NOT NULL)
- `phone` / `website` (VARCHAR)
- `logo_path` (VARCHAR)

### `user_clinics`
UNIQUE(user_id, clinic_id)
- `id` (SERIAL PRIMARY KEY)
- `user_id` (INT, FOREIGN KEY references users ON DELETE RESTRICT NOT NULL)
- `clinic_id` (INT, FOREIGN KEY references clinics ON DELETE CASCADE NOT NULL)

### `users`
The centralized table for anyone logging into the app.

- `id` (SERIAL PRIMARY KEY)
- `email` (VARCHAR UNIQUE NOT NULL)
- `password_hash` (VARCHAR NOT NULL)
- `role` (ENUM: 'admin', 'practitioner', 'patient' NOT NULL)
- `first_name` / last_name (VARCHAR NOT NULL)
- `avatar_path` (VARCHAR)
- `is_active` (BOOLEAN NOT NULL DEFAULT true) : turns to false for soft-deleting users
- `created_at` (TIMESTAMPTZ NOT NULL DEFAULT now())

### `practitioner_profiles`
- `user_id` (INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE)
- `license_number` (UNIQUE VARCHAR NOT NULL)
- `specialties` (TEXT[] NOT NULL DEFAULT '{}'::text[]) 
- `bio` (TEXT)

### `patient_profiles`
- `user_id` (INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE)
- `phone` (VARCHAR)
- `address` (VARCHAR)
- `date_of_birth` (DATE NOT NULL)

### `admin_profiles`
- `user_id` (INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE)
- `position` (VARCHAR)


## 2. Clinical Records & Messaging

### `medical_files`
The patient's permanent clinical chart. Using `JSONB` allows for unstructured intake notes, medical histories, or custom diagnostic fields.

- `id` (SERIAL PRIMARY KEY)
- `patient_id` (INT, FOREIGN KEY references users ON DELETE RESTRICT NOT NULL)
- `created_by` (INT, FOREIGN KEY references users ON DELETE RESTRICT NOT NULL) — Tracks the authoring practitioner
- `created_at` (TIMESTAMPTZ  NOT NULL DEFAULT now())
- `clinical_data` (JSONB NOT NULL DEFAULT '{}'::jsonb) — e.g., `{"past_surgeries": [...], "red_flags": "none", "objective_assessment": "..."}`

### `conversations`
UNIQUE(practitioner_id, patient_id)
- `id` (SERIAL PRIMARY KEY)
- `practitioner_id` (INT, FOREIGN KEY references users ON DELETE RESTRICT NOT NULL)
- `patient_id` (INT, FOREIGN KEY references users ON DELETE RESTRICT NOT NULL)

### `messages`
- `id` (BIGSERIAL PRIMARY KEY)
- `conversation_id` (INT, FOREIGN KEY references conversations ON DELETE CASCADE NOT NULL)
- `sender_id` (INT, FOREIGN KEY references users ON DELETE RESTRICT NOT NULL)
- `message_body` (TEXT NOT NULL)
- `read_at` (TIMESTAMPTZ)
- `sent_at` (TIMESTAMPTZ NOT NULL DEFAULT now())

## 3. Presets, Programs, and Tracking

### `exercises`
- `id` (SERIAL PRIMARY KEY)
- `external_id` (VARCHAR) : external API id, free-exercise-db has strings as ids
- `name` (VARCHAR NOT NULL)
- `primary_muscles` (TEXT[] NOT NULL DEFAULT '{}'::text[])
- `secondary_muscles` (TEXT[] NOT NULL DEFAULT '{}'::text[])
- `equipment` (TEXT[] NOT NULL DEFAULT '{}'::text[])
- `instructions` (TEXT NOT NULL)
- `media_urls` (TEXT[] NOT NULL DEFAULT '{}'::text[])
- `source` (ENUM: 'api', 'custom' NOT NULL)
- `created_by` (INT, FOREIGN KEY references users ON DELETE SET NULL) : (`NULLABLE` since it can be from api or custom)
- `is_archived` (BOOLEAN NOT NULL DEFAULT false) : default is `false` and set to `true` for soft-delete
UNIQUE(external_id) WHERE external_id IS NOT NULL

### `program_templates`
These are templates created by practitioners for later use (e.g., "Standard Rotator Cuff Phase 1").
- `id` (SERIAL PRIMARY KEY)
- `practitioner_id` (INT, FOREIGN KEY references users ON DELETE RESTRICT NOT NULL)
- `title` (VARCHAR NOT NULL)
- `description` (TEXT)
- `is_archived` (BOOLEAN NOT NULL DEFAULT false) : default is `false` and set to `true` for soft-delete

### `template_exercises`
- `id` (SERIAL PRIMARY KEY)
- `template_id` (INT, FOREIGN KEY references program_templates ON DELETE CASCADE NOT NULL)
- `exercise_id` (INT, FOREIGN KEY references exercises ON DELETE RESTRICT NOT NULL)
- `sets` (INT)
- `reps` (INT)
- `duration_in_seconds` (INT)
- `sort_order` (INT NOT NULL)
- `notes` (TEXT)

### `assigned_programs`
- `id` (SERIAL PRIMARY KEY)
- `patient_id` (INT, FOREIGN KEY references users ON DELETE RESTRICT NOT NULL)
- `assigned_by` (INT, FOREIGN KEY references users ON DELETE RESTRICT NOT NULL)
- `based_on_template_id` (INT, FOREIGN KEY references program_templates ON DELETE SET NULL)
- `title` (VARCHAR NOT NULL)
- `start_date` (DATE NOT NULL)
- `end_date` (DATE)
- `status` (ENUM: 'active', 'completed', 'on_hold', 'cancelled' NOT NULL DEFAULT 'active')
- `is_archived` (BOOLEAN NOT NULL DEFAULT false) : default is `false` and set to `true` for soft-delete

### `assigned_program_exercises`
(a COPY, not a reference, of the template's exercises)
- `id` (SERIAL PRIMARY KEY)
- `assigned_program_id` (INT, FOREIGN KEY references assigned_programs ON DELETE CASCADE NOT NULL)
- `exercise_id` (INT, FOREIGN KEY references exercises ON DELETE RESTRICT NOT NULL)
- `sets` (INT)
- `reps` (INT)
- `duration_in_seconds` (INT)
- `sort_order` (INT NOT NULL)
- `notes` (TEXT)

### `sessions`
A session is one occurrence of "patient does their exercises today"

- `id` (BIGSERIAL PRIMARY KEY)
- `assigned_program_id` (INT, FOREIGN KEY references assigned_programs ON DELETE RESTRICT NOT NULL)
- `patient_id` (INT, FOREIGN KEY references users ON DELETE RESTRICT NOT NULL)
- `scheduled_date` (TIMESTAMPTZ NOT NULL)
- `started_at` (TIMESTAMPTZ)
- `completed_at` (TIMESTAMPTZ)
- `total_duration_in_seconds` (INT)
- `status` (ENUM: 'pending', 'in_progress', 'completed', 'skipped' NOT NULL DEFAULT 'pending')
- `session_feedback` (TEXT) — Overall patient notes for the session.

### `session_exercises`
- `id` (BIGSERIAL PRIMARY KEY)
- `session_id` (INT, FOREIGN KEY references sessions ON DELETE CASCADE NOT NULL)
- `assigned_program_exercise_id` (INT, FOREIGN KEY references assigned_program_exercises ON DELETE RESTRICT NOT NULL)
- `completed` (BOOLEAN NOT NULL DEFAULT false)
- `duration_actual_in_seconds` (INT)
- `difficulty_rating` (INT CHECK (difficulty_rating BETWEEN 1 AND 10))
- `sort_order` (INT NOT NULL)
- `feedback` (TEXT)

## 4. Security & Compliance

### `audit_logs` (The Centralized Ledger)
To enforce privacy standards, this table must be Insert-Only (no updates, no deletes allowed by application permissions).

- `id` (BIGSERIAL PRIMARY KEY)
- `performed_by` (INT, FOREIGN KEY references users ON DELETE RESTRICT NOT NULL)
- `action` (VARCHAR NOT NULL) — e.g., 'ACCESS_MEDICAL_FILE', 'MODIFY_PROGRAM', 'LOGIN_SUCCESS'
- `target_user_id` (INT FOREIGN KEY references users ON DELETE RESTRICT) — The patient profile being looked at or changed
- `entity_type` (VARCHAR NOT NULL) — e.g., 'medical_files', 'patient_programs'
- `entity_id` (BIGINT) — The ID of the precise row targeted
- `created_at` (TIMESTAMPTZ NOT NULL DEFAULT now())
- `details` (JSONB) — e.g., {"field": "phone", "old": "...", "new": "..."}

# 3. Review & Feedback on Your Brainstorming Questions

**Clearance Levels / Access Control:** Rather than assigning a broad numeric "clearance level" to users, manage permissions programmatically via Role-Based Access Control (RBAC). In your backend logic, you check: `if (user.role === 'practitioner' || user.role === 'admin') { allowAccess() }`. This prevents tricky security logical gaps where a patient accidentally climbs a clearance tier.

**Photo Storage:** Storing the image path as a VARCHAR string pointing to your localized storage volume (e.g., /uploads/avatars/patient_102.png) is exactly the right approach. Never store files directly as binary blobs in the database if you want to keep the database performance light and backups nimble.

**Open-Source Exercise API integration:** Storing just the unique identifier (`api_exercise_id`) inside your JSON arrays means you don't copy massive amounts of reference documentation into your active schedules. You look up details asynchronously or on the frontend.







# TO DO

 sketch out the seed script for free-exercise-db