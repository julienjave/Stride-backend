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

import { Injectable, Logger } from '@nestjs/common'


// --- SERVICE -----------------------------------------------------------------------------------------------

// A deliberate stand-in, not a shortcut pretending to be the real thing.
// This project has no live frontend yet to receive a reset link, and no
// verified sending domain — integrating a real provider (Resend, SendGrid,
// SES) wouldn't be genuinely testable at this stage anyway. This is the
// ONLY place that would need to change to send real email later, matching
// the same "swap the provider, not the code" principle behind the
// S3-compatible storage design.
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name)

  async sendPasswordResetEmail(toEmail: string, rawToken: string): Promise<void> {
    const resetUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/reset-password?token=${rawToken}`
    this.logger.log(`[DEV EMAIL STAND-IN] Password reset link for ${toEmail}: ${resetUrl}`)
  }
}