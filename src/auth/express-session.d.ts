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

// --- MODULE AUGMENTATION ------------------------------------------------------------------------------------
// express-session's own SessionData interface has no knowledge of the
// properties this app actually stores in the session. Declaration merging
// is the standard, type-safe way to extend a third-party library's types —
// this removes the need for an `as any` cast at every access site.
import 'express-session'

declare module 'express-session' {
  interface SessionData {
    // Set by AuthController.login() when the account has MFA enabled, read
    // and cleared by AuthController.verifyMfaLogin(). Deliberately a
    // separate key from the one below — req.isAuthenticated() must stay
    // false until MFA actually succeeds, so this can't just live under the
    // key Passport itself manages.
    mfaPending?: {
      userId: number
      activeRole: string
    }

    // The key Passport's session strategy writes on every successful
    // login — the exact shape SessionSerializer.serializeUser() passes to
    // `done(null, { id, activeRole })`. HTTP requests never need to read
    // this directly (passport.session() middleware deserializes it into
    // req.user for them); MessagingGateway reads it manually, since
    // Socket.IO's handshake never runs passport.session() — see
    // session-io.adapter.ts and messaging.gateway.ts.
    passport?: {
      user: {
        id: number
        activeRole: string
      }
    }
  }
}
