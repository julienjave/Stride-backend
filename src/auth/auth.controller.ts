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
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common'
import { type Request, type Response } from 'express'
import { LocalAuthGuard } from './guards/local-auth.guard'
import { SessionAuthGuard } from '../common/guards/session-auth.guard'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { LoginDto } from './dto/login.dto'


// --- CONTROLLER --------------------------------------------------------------------------------------------
@Controller('auth')
export class AuthController {

  // === ROUTES ===========================================================

  // --- POST ROUTES ---
  
  @UseGuards(LocalAuthGuard)
  @Post('login')
  login(@Body() _dto: LoginDto, @CurrentUser() user: unknown) {
    // By the time this method body runs, LocalAuthGuard has already: run
    // LocalStrategy.validate(), called req.login() internally to establish
    // the session, and set the session cookie on the response. There's
    // nothing left to do here but return the user.
    return user
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Req() req: Request, @Res() res: Response) {
    req.logout(() => {
      req.session.destroy(() => {
        res.clearCookie('connect.sid')
        res.status(HttpStatus.NO_CONTENT).send()
      })
    })
  }

  // --- GET ROUTES ---

  @UseGuards(SessionAuthGuard)
  @Get('me')
  me(@CurrentUser() user: unknown) {
    return user
  }
}