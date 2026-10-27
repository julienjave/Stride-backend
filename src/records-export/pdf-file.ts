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

import { StreamableFile } from '@nestjs/common'
import type { RecordExport } from './records-export.service'

// --- RESPONSE ----------------------------------------------------------------------------------------------

// A copy of the record as the HTTP answer — the same for both ways in (the
// patient's own download and the emailed link), so they can't drift apart:
//   - StreamableFile: Nest sends the bytes as they are, with the type and
//     the disposition given here, instead of serialising a value;
//   - `attachment; filename=…`: the browser saves it under that name
//     rather than trying to show it in the tab.
// No length is given: for bytes already in memory, Express sets
// Content-Length by itself (the e2e tests check it matches).
// (`Cache-Control: no-store` is each route's own @Header.)
export function pdfFile({ pdf, fileName }: RecordExport): StreamableFile {
  return new StreamableFile(pdf, {
    type: 'application/pdf',
    disposition: `attachment; filename="${fileName}"`,
  })
}
