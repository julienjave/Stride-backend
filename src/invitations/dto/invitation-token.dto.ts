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

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { IsString, MaxLength } from 'class-validator'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// The token from the invitation link, sent in the request BODY — never in
// the URL. The request logger records every URL (pino-http), so a token in a
// path like /invitations/<token> would be written into the logs, where
// anyone with log access could use it. Bodies aren't logged. Same choice as
// POST /auth/reset-password.
//
// No format check (64 hex characters): a malformed token simply matches no
// invitation and gets the same 404 as a wrong one. The length cap keeps a
// huge body from being hashed for nothing.
export class InvitationTokenDto {
  @IsString()
  @MaxLength(256)
  token!: string
}