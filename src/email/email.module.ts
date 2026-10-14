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

import { Module } from '@nestjs/common'
import { EMAIL_TRANSPORT } from './email-transport'
import { createEmailTransport } from './email-transport.config'
import { EmailService } from './email.service'

// --- MODULE ------------------------------------------------------------------------------------------------

@Module({
  providers: [
    // A factory provider: instead of a class for Nest to instantiate, a
    // function whose return value becomes the thing injected under
    // EMAIL_TRANSPORT. That's how one token resolves to a different class
    // depending on configuration. Called with no arguments, it reads
    // process.env (see createEmailTransport's default parameter).
    { provide: EMAIL_TRANSPORT, useFactory: () => createEmailTransport() },
    EmailService,
  ],
  // Only EmailService is exported: the rest of the app asks for "send a
  // password reset email", never for a raw transport.
  exports: [EmailService],
})
export class EmailModule {}
