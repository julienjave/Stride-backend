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


import { Global, Module } from '@nestjs/common'
import { pgPoolProvider, drizzleProvider, DrizzlePoolCloser } from './drizzle.provider'

// @Global() — imported once here, in AppModule, and then DRIZZLE is injectable
// from any module in the app without each one separately importing DrizzleModule.
// A deliberate, narrow exception to "always import explicitly": justified because
// virtually every feature module in this app needs database access, with no
// realistic case where one wouldn't.
@Global()
@Module({
  providers: [pgPoolProvider, drizzleProvider, DrizzlePoolCloser],
  exports: [drizzleProvider],
})

export class DrizzleModule {}
