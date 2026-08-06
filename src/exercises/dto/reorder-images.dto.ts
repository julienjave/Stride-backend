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

import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  IsString,
  MaxLength,
} from 'class-validator'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// The complete new ordering, as the full list of existing object keys —
// the frontend gallery already has the whole array loaded to render it in
// the first place, so sending the full reordered list back is natural,
// not extra work.
export class ReorderImagesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20) // matches FilesInterceptor('files', 5, ...)'s per-upload cap, generous headroom for accumulated uploads over time
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  order!: string[]
}
