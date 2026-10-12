// Panel administratora: lista kont, zmiana roli, blokowanie kont.
const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../auth');

const router = express.Router();
router.use(requireRole('admin')); // cały panel tylko dla admina

const ROLES = ['user', 'support', 'admin'];

router.get('/users', async (req, res) => {
    const { rows } = await pool.query(
        `SELECT u.id, u.username, u.role, u.is_active, u.created_at,
                COUNT(t.id)::int AS ticket_count
           FROM users u LEFT JOIN tickets t ON t.author_id = u.id
       GROUP BY u.id ORDER BY u.id`
    );
    res.render('admin/users', { users: rows, ROLES });
});

router.post('/users/:id', async (req, res) => {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : null;
    const role = ROLES.includes(req.body.role) ? req.body.role : null;
    const isActive = req.body.is_active === 'on'; // checkbox

    if (id === null || role === null) {
        req.session.flash = 'Nieprawidłowe dane.';
    } else if (id === req.user.id) {
        // admin nie może odebrać sobie uprawnień ani zablokować sam siebie
        req.session.flash = 'Nie możesz zmienić własnego konta w tym panelu.';
    } else {
        const r = await pool.query(
            'UPDATE users SET role = $1, is_active = $2 WHERE id = $3',
            [role, isActive, id]
        );
        req.session.flash = r.rowCount ? 'Zapisano zmiany.' : 'Nie znaleziono użytkownika.';
    }
    res.redirect('/admin/users');
});

module.exports = router;
