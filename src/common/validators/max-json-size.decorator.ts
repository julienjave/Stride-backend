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

import { registerDecorator, ValidationOptions, ValidationArguments } from 'class-validator'


// --- DECORATOR ---------------------------------------------------------------------------------------------

// A CUSTOM validator — the same underlying mechanism every built-in
// class-validator decorator (@IsString, @IsEmail, etc.) is itself built
// from. Worth reaching for whenever a rule genuinely isn't one of the
// built-ins: here, "how long is this string" doesn't apply to an
// intentionally unstructured object — what actually needs bounding is how
// large the value becomes once serialized, regardless of its internal shape.
export function MaxJsonSize(maxBytes: number, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'maxJsonSize',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      // constraints carries the decorator's own argument (maxBytes) through
      // to the validate() function below — decorators are evaluated once,
      // at class-definition time, but validate() runs fresh on every
      // request, so this is how the configured limit reaches it each time.
      constraints: [maxBytes],
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const [max] = args.constraints
          try {
            return Buffer.byteLength(JSON.stringify(value), 'utf8') <= max
          } catch {
            return false; // not serializable at all — definitely invalid
          }
        },
        defaultMessage(args: ValidationArguments) {
          const [max] = args.constraints
          return `${args.property} must not exceed ${max} bytes when serialized as JSON`
        },
      },
    })
  }
}