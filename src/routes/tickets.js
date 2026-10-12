// Zgłoszenia i komentarze.
// Zasada dostępu:
//   user    -> widzi i komentuje TYLKO swoje zgłoszenia
//   support -> widzi wszystkie, komentuje, zmienia status/priorytet/przypisanie
//   admin   -> jak support (+ panel użytkowników w admin.js)
const express = require('express');
const { pool } = require('../db');
const { requireLogin, requireRole } = require('../auth');

const router = express.Router();
router.use(requireLogin); // wszystko poniżej wymaga zalogowania

const STATUSES = ['open', 'in_progress', 'closed'];
const PRIORITIES = ['low', 'medium', 'high'];

// Zamienia parametr z URL na liczbę całkowitą (albo null, gdy to nie liczba)
function parseId(value) {
    return /^\d+$/.test(value) ? Number(value) : null;
}

// Pobiera zgłoszenie i SPRAWDZA, czy użytkownik ma do niego dostęp.
// To jest kluczowa kontrola przeciw IDOR (podmiana id w adresie).
async function getTicketForUser(id, user) {
    if (id === null) return { status: 404 };
    const { rows } = await pool.query(
        `SELECT t.*, a.username AS author_name, s.username AS assignee_name
           FROM tickets t
           JOIN users a ON a.id = t.author_id
      LEFT JOIN users s ON s.id = t.assignee_id
          WHERE t.id = $1`,
        [id]
    );
    const ticket = rows[0];
    if (!ticket) return { status: 404 };
    if (user.role === 'user' && ticket.author_id !== user.id) return { status: 403 };
    return { ticket };
}

function renderDenied(res, status) {
    const message = status === 403 ? 'Nie masz dostępu do tego zgłoszenia.' : 'Nie znaleziono zgłoszenia.';
    res.status(status).render('error', { status, message });
}

// --- Lista zgłoszeń + wyszukiwarka + filtr statusu ---
router.get('/', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const status = STATUSES.includes(req.query.status) ? req.query.status : '';

    const where = [];
    const params = [];
    if (req.user.role === 'user') {
        params.push(req.user.id);
        where.push(`t.author_id = $${params.length}`);
    }
    if (q) {
        params.push(`%${q}%`);
        where.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length})`);
    }
    if (status) {
        params.push(status);
        where.push(`t.status = $${params.length}`);
    }

    const { rows } = await pool.query(
        `SELECT t.id, t.title, t.status, t.priority, t.updated_at,
                a.username AS author_name, s.username AS assignee_name
           FROM tickets t
           JOIN users a ON a.id = t.author_id
      LEFT JOIN users s ON s.id = t.assignee_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY t.updated_at DESC`,
        params
    );
    res.render('tickets/list', { tickets: rows, q, status, STATUSES });
});

// --- Nowe zgłoszenie ---
router.get('/new', (req, res) => {
    res.render('tickets/new', { error: null, form: {}, PRIORITIES });
});

router.post('/', async (req, res) => {
    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim();
    const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'medium';

    let error = null;
    if (title.length < 3 || title.length > 200) error = 'Tytuł: 3-200 znaków.';
    else if (!description || description.length > 5000) error = 'Opis: 1-5000 znaków.';
    if (error) {
        return res.status(400).render('tickets/new', { error, form: { title, description, priority }, PRIORITIES });
    }

    // author_id bierzemy z sesji, NIE z formularza
    const { rows } = await pool.query(
        'INSERT INTO tickets (title, description, priority, author_id) VALUES ($1, $2, $3, $4) RETURNING id',
        [title, description, priority, req.user.id]
    );
    res.redirect(`/tickets/${rows[0].id}`);
});

// --- Szczegóły zgłoszenia + komentarze ---
router.get('/:id', async (req, res) => {
    const { ticket, status } = await getTicketForUser(parseId(req.params.id), req.user);
    if (!ticket) return renderDenied(res, status);

    const comments = await pool.query(
        `SELECT c.body, c.created_at, u.username, u.role
           FROM comments c JOIN users u ON u.id = c.author_id
          WHERE c.ticket_id = $1 ORDER BY c.created_at`,
        [ticket.id]
    );
    let staff = [];
    if (req.user.role !== 'user') {
        staff = (await pool.query(
            "SELECT id, username FROM users WHERE role IN ('support','admin') AND is_active ORDER BY username"
        )).rows;
    }
    res.render('tickets/show', { ticket, comments: comments.rows, staff, STATUSES, PRIORITIES });
});

// --- Dodanie komentarza ---
router.post('/:id/comments', async (req, res) => {
    const { ticket, status } = await getTicketForUser(parseId(req.params.id), req.user);
    if (!ticket) return renderDenied(res, status);

    const body = String(req.body.body || '').trim();
    if (ticket.status === 'closed') {
        req.session.flash = 'Zgłoszenie jest zamknięte - nie można dodać komentarza.';
    } else if (!body || body.length > 2000) {
        req.session.flash = 'Komentarz: 1-2000 znaków.';
    } else {
        await pool.query(
            'INSERT INTO comments (ticket_id, author_id, body) VALUES ($1, $2, $3)',
            [ticket.id, req.user.id, body]
        );
        await pool.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [ticket.id]);
    }
    res.redirect(`/tickets/${ticket.id}`);
});

// --- Zmiana statusu / priorytetu / przypisania (tylko support i admin) ---
router.post('/:id/update', requireRole('support', 'admin'), async (req, res) => {
    const { ticket, status } = await getTicketForUser(parseId(req.params.id), req.user);
    if (!ticket) return renderDenied(res, status);

    const newStatus = STATUSES.includes(req.body.status) ? req.body.status : ticket.status;
    const newPriority = PRIORITIES.includes(req.body.priority) ? req.body.priority : ticket.priority;
    let assigneeId = parseId(String(req.body.assignee_id || ''));
    if (assigneeId !== null) {
        // przypisać można tylko aktywnego pracownika supportu/admina
        const ok = await pool.query(
            "SELECT 1 FROM users WHERE id = $1 AND role IN ('support','admin') AND is_active",
            [assigneeId]
        );
        if (ok.rowCount === 0) assigneeId = null;
    }

    await pool.query(
        `UPDATE tickets SET status = $1, priority = $2, assignee_id = $3, updated_at = now()
          WHERE id = $4`,
        [newStatus, newPriority, assigneeId, ticket.id]
    );
    req.session.flash = 'Zgłoszenie zaktualizowane.';
    res.redirect(`/tickets/${ticket.id}`);
});

module.exports = router;
