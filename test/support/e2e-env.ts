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

// Runs before EVERY e2e file (jest-e2e.json, "setupFiles"), ahead of the
// file's own imports — so ahead of its `import 'dotenv/config'`, which never
// overwrites a variable that is already set.
//
// Rate limits OFF for the e2e suites (config/rate-limits.ts): they send far
// more requests than a person would, and used to share fixtures and count
// their logins to stay under 60 a minute per route and 5 logins a minute.
// test/rate-limits.e2e-spec.ts switches them back ON, before building its
// app, to prove the limits work. Set unconditionally: a developer's .env
// saying RATE_LIMITS=on must not make the other suites fail with 429.
process.env.RATE_LIMITS = 'off'
