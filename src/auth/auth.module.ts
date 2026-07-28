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
import { PassportModule } from '@nestjs/passport'
import { UsersModule } from '../users/users.module'
import { EmailModule } from '../email/email.module'
import { AuthService } from './auth.service'
import { AuthController } from './auth.controller'
import { SessionSerializer } from './strategies/session.serializer'


// --- MODULE ------------------------------------------------------------------------------------------------
@Module({
  imports: [
    UsersModule,
    EmailModule, // AuthService injects EmailService, for forgotPassword()
    PassportModule.register({ session: true }), // session: true = use req.login()/sessions, not JWT issuance
  ],
  controllers: [AuthController],
  providers: [AuthService, SessionSerializer],
  exports: [AuthService],
})
export class AuthModule {}