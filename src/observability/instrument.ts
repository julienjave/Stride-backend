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

// Starts error reporting — imported on the FIRST line of main.ts, before Nest
// or any module of the app is loaded. The SDK installs its process-level
// handlers (an uncaught exception, an unhandled rejection) when it starts; an
// error thrown while the app's modules load would be missed by a later start.
//
// Only main.ts imports this file: the e2e suites, the seed and the scripts
// build the same modules WITHOUT it, so they never report — and with no
// SENTRY_DSN (the default) this starts nothing even here.
//
// Why a file imported first and not `node --import`: Stride's build is
// CommonJS, where an import on the first line runs first; `--require` is no
// longer supported by the SDK, and `--import` would add a flag to the
// Dockerfile's CMD for the same result.

import 'dotenv/config'
import * as Sentry from '@sentry/nestjs'
import { errorReportingConfig } from './error-reporting-config'
import { errorReportingOptions } from './error-reporting'

const options = errorReportingOptions(errorReportingConfig())
if (options) Sentry.init(options)
