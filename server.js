'use strict';

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const http = require('http');
const { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// ── Database ──────────────────────────────────────────────────────────────────

function createDb(dbPath) {
  const db = new DatabaseSync(dbPath || ':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK(role IN ('coordinator','first_aider'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT NOT NULL,
      date     TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      status   TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','closed'))
    );

    CREATE TABLE IF NOT EXISTS teams (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS patients (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id             INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      location_description TEXT    NOT NULL,
      incident_type        TEXT    NOT NULL,
      triage_level         TEXT    NOT NULL DEFAULT 'green'
                                   CHECK(triage_level IN ('red','yellow','green')),
      team_id              INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      status               TEXT    NOT NULL DEFAULT 'waiting'
                                   CHECK(status IN ('waiting','assigned','treated')),
      notes                TEXT    NOT NULL DEFAULT '',
      created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed default users on a fresh database
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count === 0) {
    const salt = bcrypt.genSaltSync(10);
    const insert = db.prepare(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    );
    insert.run('coordinator',  bcrypt.hashSync('coordinator123', salt), 'coordinator');
    insert.run('firstaid1',    bcrypt.hashSync('firstaid123',    salt), 'first_aider');
    insert.run('firstaid2',    bcrypt.hashSync('firstaid123',    salt), 'first_aider');
    insert.run('firstaid3',    bcrypt.hashSync('firstaid123',    salt), 'first_aider');
    console.log('Seeded default accounts (coordinator / firstaid1-3)');
  }

  return db;
}

// ── App factory ───────────────────────────────────────────────────────────────

function createApp(db) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  // ── Middleware ──────────────────────────────────────────────────────────────

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(
    session({
      secret: process.env.SESSION_SECRET || 'redcross-dev-secret-change-in-production',
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge:   24 * 60 * 60 * 1000,
        httpOnly: true,
        // SameSite=lax prevents CSRF – cross-site form submissions cannot carry the cookie
        sameSite: 'lax',
        // Enforce HTTPS-only cookies in production (set NODE_ENV=production when deploying over TLS)
        secure:   process.env.NODE_ENV === 'production',
      },
    })
  );
  app.use(express.static(path.join(__dirname, 'public')));

  // ── Auth helpers ────────────────────────────────────────────────────────────

  function requireAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    next();
  }

  function requireCoordinator(req, res, next) {
    if (!req.session.userId)           return res.status(401).json({ error: 'Not authenticated' });
    if (req.session.userRole !== 'coordinator')
                                       return res.status(403).json({ error: 'Coordinator role required' });
    next();
  }

  // ── Auth routes ─────────────────────────────────────────────────────────────

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password are required' });

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });

    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.userRole = user.role;
    req.session.eventId  = null;
    res.json({ id: user.id, username: user.username, role: user.role });
  });

  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({
      id:       req.session.userId,
      username: req.session.username,
      role:     req.session.userRole,
      eventId:  req.session.eventId || null,
    });
  });

  // ── Events ──────────────────────────────────────────────────────────────────

  app.get('/api/events', requireAuth, (_req, res) => {
    res.json(
      db.prepare('SELECT * FROM events ORDER BY date DESC, id DESC').all()
    );
  });

  app.post('/api/events', requireCoordinator, (req, res) => {
    const { name, date, location } = req.body;
    if (!name || !date) return res.status(400).json({ error: 'name and date are required' });

    const r = db
      .prepare('INSERT INTO events (name, date, location) VALUES (?, ?, ?)')
      .run(name, date, location || '');
    res.status(201).json(db.prepare('SELECT * FROM events WHERE id = ?').get(r.lastInsertRowid));
  });

  app.get('/api/events/:id', requireAuth, (req, res) => {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    res.json(ev);
  });

  app.put('/api/events/:id', requireCoordinator, (req, res) => {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Event not found' });

    const { name, date, location, status } = req.body;
    db.prepare(
      'UPDATE events SET name=?, date=?, location=?, status=? WHERE id=?'
    ).run(
      name     ?? ev.name,
      date     ?? ev.date,
      location ?? ev.location,
      status   ?? ev.status,
      req.params.id
    );
    res.json(db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id));
  });

  // Store the chosen event in the session (one event at a time per user)
  app.post('/api/events/:id/select', requireAuth, (req, res) => {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    req.session.eventId = Number(req.params.id);
    res.json({ ok: true, eventId: req.session.eventId });
  });

  // ── Teams ───────────────────────────────────────────────────────────────────

  function enrichTeams(teams) {
    return teams.map(t => ({
      ...t,
      members: db
        .prepare(
          `SELECT u.id, u.username
             FROM team_members tm
             JOIN users u ON tm.user_id = u.id
            WHERE tm.team_id = ?`
        )
        .all(t.id),
    }));
  }

  app.get('/api/events/:eventId/teams', requireAuth, (req, res) => {
    const teams = db
      .prepare('SELECT * FROM teams WHERE event_id = ? ORDER BY name')
      .all(req.params.eventId);
    res.json(enrichTeams(teams));
  });

  app.post('/api/events/:eventId/teams', requireCoordinator, (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Team name is required' });

    const ev = db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.eventId);
    if (!ev) return res.status(404).json({ error: 'Event not found' });

    const r = db
      .prepare('INSERT INTO teams (event_id, name) VALUES (?, ?)')
      .run(req.params.eventId, name);
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json({ ...team, members: [] });
  });

  app.delete('/api/events/:eventId/teams/:teamId', requireCoordinator, (req, res) => {
    db.prepare('DELETE FROM teams WHERE id = ? AND event_id = ?').run(
      req.params.teamId,
      req.params.eventId
    );
    res.json({ ok: true });
  });

  app.post('/api/teams/:teamId/members', requireCoordinator, (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'first_aider'").get(userId);
    if (!user) return res.status(404).json({ error: 'First aider not found' });

    db.prepare(
      'INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)'
    ).run(req.params.teamId, userId);
    res.json({ ok: true });
  });

  app.delete('/api/teams/:teamId/members/:userId', requireCoordinator, (req, res) => {
    db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(
      req.params.teamId,
      req.params.userId
    );
    res.json({ ok: true });
  });

  // All first aiders (for team management UI)
  app.get('/api/users/first-aiders', requireCoordinator, (_req, res) => {
    res.json(
      db.prepare("SELECT id, username FROM users WHERE role = 'first_aider' ORDER BY username").all()
    );
  });

  // ── Patients ────────────────────────────────────────────────────────────────

  const PATIENT_SELECT = `
    SELECT p.*, t.name AS team_name
      FROM patients p
      LEFT JOIN teams t ON p.team_id = t.id
  `;
  const TRIAGE_ORDER = `
    ORDER BY CASE p.triage_level
               WHEN 'red'    THEN 1
               WHEN 'yellow' THEN 2
               WHEN 'green'  THEN 3
             END, p.created_at ASC
  `;

  app.get('/api/events/:eventId/patients', requireAuth, (req, res) => {
    if (req.session.userRole === 'first_aider') {
      // First aiders only see patients assigned to their team(s) in this event
      const patients = db
        .prepare(
          `${PATIENT_SELECT}
            INNER JOIN team_members tm ON p.team_id = tm.team_id
            WHERE p.event_id = ? AND tm.user_id = ?
            ${TRIAGE_ORDER}`
        )
        .all(req.params.eventId, req.session.userId);
      return res.json(patients);
    }

    // Coordinators see all patients for the event
    const patients = db
      .prepare(`${PATIENT_SELECT} WHERE p.event_id = ? ${TRIAGE_ORDER}`)
      .all(req.params.eventId);
    res.json(patients);
  });

  app.post('/api/events/:eventId/patients', requireCoordinator, (req, res) => {
    const { location_description, incident_type, triage_level, team_id, notes } = req.body;

    if (!location_description || !incident_type || !triage_level)
      return res.status(400).json({
        error: 'location_description, incident_type, and triage_level are required',
      });
    if (!['red', 'yellow', 'green'].includes(triage_level))
      return res.status(400).json({ error: 'triage_level must be red, yellow, or green' });

    const status = team_id ? 'assigned' : 'waiting';
    const r = db
      .prepare(
        `INSERT INTO patients
           (event_id, location_description, incident_type, triage_level, team_id, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.params.eventId,
        location_description,
        incident_type,
        triage_level,
        team_id || null,
        status,
        notes || ''
      );

    const patient = db
      .prepare(`${PATIENT_SELECT} WHERE p.id = ?`)
      .get(r.lastInsertRowid);

    io.to(`event-${req.params.eventId}`).emit('patient-added', patient);
    res.status(201).json(patient);
  });

  app.put('/api/patients/:id', requireCoordinator, (req, res) => {
    const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const {
      location_description,
      incident_type,
      triage_level,
      team_id,
      status,
      notes,
    } = req.body;

    const newTriageLevel = triage_level || patient.triage_level;
    if (!['red', 'yellow', 'green'].includes(newTriageLevel))
      return res.status(400).json({ error: 'triage_level must be red, yellow, or green' });

    // Resolve team_id: explicit null clears it, undefined keeps existing
    const newTeamId = team_id !== undefined ? (team_id || null) : patient.team_id;

    // Auto-derive status when team changes
    let newStatus = status || patient.status;
    if (team_id !== undefined) {
      if (team_id && newStatus === 'waiting') newStatus = 'assigned';
      if (!team_id && newStatus === 'assigned') newStatus = 'waiting';
    }
    // Allow manual override to 'treated'
    if (status === 'treated') newStatus = 'treated';
    if (!['waiting', 'assigned', 'treated'].includes(newStatus))
      return res.status(400).json({ error: 'status must be waiting, assigned, or treated' });

    db.prepare(
      `UPDATE patients
          SET location_description = ?,
              incident_type        = ?,
              triage_level         = ?,
              team_id              = ?,
              status               = ?,
              notes                = ?
        WHERE id = ?`
    ).run(
      location_description ?? patient.location_description,
      incident_type        ?? patient.incident_type,
      newTriageLevel,
      newTeamId,
      newStatus,
      notes !== undefined ? notes : patient.notes,
      req.params.id
    );

    const updated = db.prepare(`${PATIENT_SELECT} WHERE p.id = ?`).get(req.params.id);
    io.to(`event-${patient.event_id}`).emit('patient-updated', updated);
    res.json(updated);
  });

  app.delete('/api/patients/:id', requireCoordinator, (req, res) => {
    const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    db.prepare('DELETE FROM patients WHERE id = ?').run(req.params.id);
    io.to(`event-${patient.event_id}`).emit('patient-deleted', { id: Number(req.params.id) });
    res.json({ ok: true });
  });

  // ── Socket.io ───────────────────────────────────────────────────────────────

  io.on('connection', socket => {
    socket.on('join-event', eventId => socket.join(`event-${eventId}`));
    socket.on('leave-event', eventId => socket.leave(`event-${eventId}`));
  });

  // ── Fallback ────────────────────────────────────────────────────────────────
  // Serve login for unknown routes (SPA-style catch-all for non-API paths)
  app.get(/^(?!\/api).*$/, (_req, res) => {
    res.redirect('/login.html');
  });

  return { app, httpServer, io };
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (require.main === module) {
  const db = createDb(process.env.DB_PATH || './data.db');
  const { httpServer } = createApp(db);
  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () =>
    console.log(`Red Cross Coordinator running → http://localhost:${PORT}`)
  );
}

module.exports = { createApp, createDb };
