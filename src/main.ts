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


import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { AppModule } from './app.module'

async function bootstrap() {
    const app = await NestFactory.create(AppModule)

    // Registered ONCE here, globally — applies to every route in the app
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,             // strips any property NOT declared on the DTO
            forbidNonWhitelisted: true,  // ...and rejects the request outright if it finds one
            transform: true,             // converts plain incoming JSON into a real instance of the DTO class
        }),
    )

    await app.listen(process.env.PORT ?? 3000)
}
bootstrap()
