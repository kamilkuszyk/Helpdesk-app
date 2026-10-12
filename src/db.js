// Jedna wspólna pula połączeń do PostgreSQL dla całej aplikacji.
const { Pool } = require('pg');

const pool = new Pool({
    // np. postgres://helpdesk:haslo@localhost:5432/helpdesk
    connectionString: process.env.DATABASE_URL,
    // W chmurze (zarządzana baza) włączymy szyfrowanie: DB_SSL=true
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
    max: 10,
});

module.exports = { pool };
