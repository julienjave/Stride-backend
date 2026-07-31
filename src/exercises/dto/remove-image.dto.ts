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

import { IsString, MaxLength } from 'class-validator'


// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// A DELETE with a body is a little unusual REST style — but object keys
// contain slashes (exercises/874/upload-.../0.jpg), which makes them
// awkward and error-prone as a raw URL path segment. A body is the more
// practical choice here.
export class RemoveImageDto {
  @IsString()
  @MaxLength(500)
  objectKey!: string
}