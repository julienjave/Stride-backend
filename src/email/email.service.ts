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
import { Resend } from 'resend'


// --- SERVICE -----------------------------------------------------------------------------------------------

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name)
  private readonly resend = new Resend(process.env.RESEND_API_KEY)

  async sendPasswordResetEmail(toEmail: string, rawToken: string): Promise<void> {
    const resetUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/reset-password?token=${rawToken}`

    // Resend's SDK returns errors as a VALUE ({ error }), never throws them —
    // must be checked explicitly, or a failed send would silently look
    // identical to a successful one.
    const { data, error } = await this.resend.emails.send({
      from: process.env.EMAIL_FROM ?? 'Stride <onboarding@resend.dev>',
      to: toEmail,
      subject: 'Reset your Stride password',
      html: `<p>Someone requested a password reset for this account.</p>
             <p><a href="${resetUrl}">Reset your password</a> — this link expires in 1 hour.</p>
             <p>If you didn't request this, you can safely ignore this email.</p>`,
    })

    if (error) {
      // Logged for operator visibility, but DELIBERATELY not thrown further.
      // Letting this propagate would give forgotPassword() a different
      // response (500) than the "email doesn't exist" case (204) — leaking
      // exactly the account-existence signal that endpoint exists to hide.
      // A send failure and a nonexistent email must look identical to the caller.
      this.logger.error(`Failed to send password reset email to ${toEmail}`, error)
      return
    }

    this.logger.log(`Password reset email sent to ${toEmail} (id: ${data?.id})`)
  }
}