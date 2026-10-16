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

import { IsInt, IsOptional, Min } from 'class-validator'
import { IsFeedback, IsScore } from './session-fields'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST /sessions/:id/complete — Finish (Phase 4 step 1, decided 2026-10-15).
// The check-out comes WITH it: once completed, a session never changes, so
// the screen before this request is where the patient reviews. Everything is
// optional (decisions §6: never nag, never block); null = "not answered",
// the same as leaving it out.
export class CompleteSessionDto {
  @IsOptional()
  @IsScore()
  painAfter?: number | null

  @IsOptional()
  @IsScore()
  mobilityAfter?: number | null

  // From the app's own timer (it can leave out a pause), so it is the
  // client's number — but never longer than the time since the session
  // started (assertDurationPossible).
  @IsOptional()
  @IsInt()
  @Min(0)
  totalDurationInSeconds?: number | null

  // The patient's words about the whole session: optional, never blank
  // (IsFeedback).
  @IsOptional()
  @IsFeedback()
  sessionFeedback?: string | null
}
