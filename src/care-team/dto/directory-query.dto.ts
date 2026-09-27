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

import { IsOptional, IsString, MaxLength } from 'class-validator'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// GET /directory/patients?search=… — the text a practitioner types to find
// a patient by name. Optional: without it, the directory lists the first
// patients of the practitioner's clinics, alphabetically.
export class DirectoryQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string
}