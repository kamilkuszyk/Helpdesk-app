// Inicjalizacja bazy: tworzy tabele (schema.sql) i - jeśli baza jest pusta -
// wgrywa dane testowe. Uruchamiane automatycznie przed startem serwera.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');

// Blokada w bazie: gdy kilka instancji aplikacji startuje naraz
// (skalowanie), tylko jedna na raz wykonuje inicjalizację.
const LOCK_ID = 727001;

async function seed(client) {
    // Konta testowe TYLKO dla środowiska DEV
    const users = [
        ['admin', 'Admin123!', 'admin'],
        ['support', 'Support123!', 'support'],
        ['jan', 'User123!', 'user'],
        ['anna', 'User123!', 'user'],
    ];
    const ids = {};
    for (const [username, password, role] of users) {
        const hash = await bcrypt.hash(password, 12);
        const { rows } = await client.query(
            'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
            [username, hash, role]
        );
        ids[username] = rows[0].id;
    }

    const t1 = await client.query(
        `INSERT INTO tickets (title, description, priority, author_id, assignee_id, status)
         VALUES ($1, $2, 'high', $3, $4, 'in_progress') RETURNING id`,
        ['Nie mogę zalogować się do poczty', 'Od rana Outlook pokazuje błąd uwierzytelniania.', ids.jan, ids.support]
    );
    await client.query(
        `INSERT INTO tickets (title, description, priority, author_id)
         VALUES ($1, $2, 'low', $3)`,
        ['Prośba o nową myszkę', 'Kółko w myszce przestało działać.', ids.jan]
    );
    await client.query(
        `INSERT INTO tickets (title, description, priority, author_id)
         VALUES ($1, $2, 'medium', $3)`,
        ['Drukarka na 2. piętrze nie drukuje', 'Zadania stoją w kolejce i nic się nie dzieje.', ids.anna]
    );
    await client.query(
        'INSERT INTO comments (ticket_id, author_id, body) VALUES ($1, $2, $3), ($1, $4, $5)',
        [t1.rows[0].id, ids.support, 'Sprawdzamy. Czy zmieniał Pan ostatnio hasło?', ids.jan, 'Tak, wczoraj.']
    );
}

async function main() {
    const client = await pool.connect();
    try {
        await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
        const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
        await client.query(schema);

        const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM users');
        if (rows[0].n === 0 && process.env.SEED_DEMO_DATA !== 'false') {
            await client.query('BEGIN');
            await seed(client);
            await client.query('COMMIT');
            console.log('[init-db] Wgrano dane testowe.');
        }
        console.log('[init-db] Baza gotowa.');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
        client.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error('[init-db] Błąd:', err.message);
    process.exit(1);
});
