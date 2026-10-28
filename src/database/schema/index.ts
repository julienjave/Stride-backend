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

// Re-exports every schema file from one place. Anything that needs the full schema
// graph (drizzle.provider.ts, drizzle.config.ts) imports from here, rather than
// listing all nine files individually and having to remember to update every
// import site whenever a new schema file is added.
export * from './weight-unit.schema'
export * from './clinics.schema'
export * from './users.schema'
export * from './care-team.schema'
export * from './invitations.schema'
export * from './email-change-requests.schema'
export * from './records-export-links.schema'
export * from './mfa-recovery-codes.schema'
export * from './medical-files.schema'
export * from './messaging.schema'
export * from './exercises.schema'
export * from './programs.schema'
export * from './program-schedules.schema'
export * from './sessions.schema'
export * from './audit-logs.schema'

export * from './session-reviews.schema'
export * from './program-alert-reviews.schema'
export * from './care-team-join-reviews.schema'
