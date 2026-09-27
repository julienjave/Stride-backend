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
// -----------------------------------------------------------------------------------------------------------

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// In its own file (moved out of users.service.ts, 2026-09-27) because two
// services now turn a stored avatar key into a presigned URL: UsersService
// (profiles) and CareTeamService (the clinic directory and care-team lists).
// Importing it from users.service.ts would have created a circular import
// between those two services' files.
//
// How long a user's avatarUrl (a presigned RustFS URL) stays valid. Same
// 24 hours as a clinic logo, for the same reasons (see
// CLINIC_LOGO_URL_EXPIRY_SECONDS in clinics.service.ts): long enough to
// outlive an ordinary working session, far shorter than the 7-day login
// session, so a URL that leaks (browser history, a screenshot, a log
// line) stops working long before the session that produced it would.
//
// One difference from logos, accepted knowingly (design decisions): the
// logged-in user's OWN avatarUrl arrives through GET /auth/me, which the
// frontend caches with no expiry and only reloads on a full page load.
// A tab left open for more than 24 hours without a reload can therefore
// hold an expired URL. The frontend's UserAvatar falls back to initials
// when the image fails to load, so the worst case is initials in place
// of the photo until the next reload — never a broken image.
export const AVATAR_URL_EXPIRY_SECONDS = 60 * 60 * 24