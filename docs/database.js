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


// --- REQUIRES AND VARIABLES --------------------------------------------------------------------------------

const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')
require('dotenv').config()


// --- CONNECTION ---------------------------------------------------------------------------------------------

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
})

// 1. Test the connection immediately when the server boots up
pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ Error acquiring client: Failed to connect to PostgreSQL database!', err.stack)
  }
  console.log('🚀 Successfully connected to the PostgreSQL database.')
  release() // Crucial: release the test client back into the pool immediately!
})

// 2. Handle unexpected background errors on idle clients
pool.on('error', (err) => {
  console.error('⚠️ Unexpected error on idle PostgreSQL client!', err)
  // In production, we might want to alert an external tracking system here
})


// --- MODULE EXPORT -------------------------------------------------------------------------------------------

// Helper function to export for executing queries
module.exports = {
  query: (text, params) => pool.query(text, params),
}