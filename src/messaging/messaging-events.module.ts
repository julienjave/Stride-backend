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
import { MessagingEvents } from './messaging-events'

// --- MODULE ------------------------------------------------------------------------------------------------

// MessagingEvents in a module of its own, with nothing to import. Two
// modules need it — MessagingModule (the service emits, the gateway
// attaches the server) and AuthModule (logout and switch-role close the
// session's sockets) — and Nest gives every importer the SAME instance (a
// module's providers are singletons), which is what makes "the gateway
// attaches, the others emit" work. Putting it inside MessagingModule would
// make AuthModule import all of messaging — and messaging already imports
// UsersModule, which sits next to auth: a cycle waiting to happen.
@Module({
  providers: [MessagingEvents],
  exports: [MessagingEvents],
})
export class MessagingEventsModule {}
