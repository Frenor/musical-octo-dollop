'use strict';

const request  = require('supertest');
const { createApp, createDb } = require('../server');

// Each test suite gets a fresh in-memory database so tests are isolated.
function setup() {
  const db = createDb(); // ':memory:'
  const { app } = createApp(db);
  return { app, db };
}

// Helper: log in and return the agent (cookie jar)
async function loginAs(app, username, password) {
  const agent = request.agent(app);
  await agent
    .post('/api/auth/login')
    .send({ username, password })
    .expect(200);
  return agent;
}

// ── Auth ─────────────────────────────────────────────────────────────────────
describe('Auth', () => {
  let app;
  beforeAll(() => ({ app } = setup()));

  test('rejects missing credentials', async () => {
    const { app } = setup();
    await request(app).post('/api/auth/login').send({}).expect(400);
  });

  test('rejects wrong password', async () => {
    const { app } = setup();
    await request(app)
      .post('/api/auth/login')
      .send({ username: 'coordinator', password: 'wrong' })
      .expect(401);
  });

  test('login succeeds for seeded coordinator', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'coordinator', password: 'coordinator123' })
      .expect(200);
    expect(res.body.role).toBe('coordinator');
  });

  test('login succeeds for seeded first_aider', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'firstaid1', password: 'firstaid123' })
      .expect(200);
    expect(res.body.role).toBe('first_aider');
  });

  test('/api/auth/me returns 401 when not logged in', async () => {
    const { app } = setup();
    await request(app).get('/api/auth/me').expect(401);
  });

  test('/api/auth/me returns user after login', async () => {
    const { app } = setup();
    const agent = await loginAs(app, 'coordinator', 'coordinator123');
    const res   = await agent.get('/api/auth/me').expect(200);
    expect(res.body.username).toBe('coordinator');
  });

  test('logout clears session', async () => {
    const { app } = setup();
    const agent = await loginAs(app, 'coordinator', 'coordinator123');
    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/auth/me').expect(401);
  });
});

// ── Events ───────────────────────────────────────────────────────────────────
describe('Events', () => {
  test('coordinator can create an event', async () => {
    const { app } = setup();
    const agent   = await loginAs(app, 'coordinator', 'coordinator123');
    const res = await agent
      .post('/api/events')
      .send({ name: 'Test Event', date: '2026-06-01', location: 'City Park' })
      .expect(201);
    expect(res.body.name).toBe('Test Event');
    expect(res.body.status).toBe('active');
  });

  test('first_aider cannot create an event', async () => {
    const { app } = setup();
    const agent   = await loginAs(app, 'firstaid1', 'firstaid123');
    await agent.post('/api/events').send({ name: 'X', date: '2026-01-01' }).expect(403);
  });

  test('event creation requires name and date', async () => {
    const { app } = setup();
    const agent   = await loginAs(app, 'coordinator', 'coordinator123');
    await agent.post('/api/events').send({ name: 'No date' }).expect(400);
  });

  test('list events returns created events', async () => {
    const { app } = setup();
    const agent   = await loginAs(app, 'coordinator', 'coordinator123');
    await agent.post('/api/events').send({ name: 'E1', date: '2026-01-01' });
    await agent.post('/api/events').send({ name: 'E2', date: '2026-02-01' });
    const res = await agent.get('/api/events').expect(200);
    expect(res.body.length).toBe(2);
  });

  test('coordinator can update an event', async () => {
    const { app } = setup();
    const agent   = await loginAs(app, 'coordinator', 'coordinator123');
    const created = (await agent.post('/api/events').send({ name: 'Old', date: '2026-01-01' })).body;
    const updated = (await agent.put(`/api/events/${created.id}`).send({ name: 'New', status: 'closed' })).body;
    expect(updated.name).toBe('New');
    expect(updated.status).toBe('closed');
  });

  test('select event stores it in session', async () => {
    const { app } = setup();
    const agent   = await loginAs(app, 'coordinator', 'coordinator123');
    const ev      = (await agent.post('/api/events').send({ name: 'E', date: '2026-01-01' })).body;
    await agent.post(`/api/events/${ev.id}/select`).expect(200);
    const me = (await agent.get('/api/auth/me')).body;
    expect(me.eventId).toBe(ev.id);
  });
});

// ── Teams ────────────────────────────────────────────────────────────────────
describe('Teams', () => {
  async function makeEventAndTeam() {
    const { app, db } = setup();
    const coord  = await loginAs(app, 'coordinator', 'coordinator123');
    const ev     = (await coord.post('/api/events').send({ name: 'E', date: '2026-01-01' })).body;
    const team   = (await coord.post(`/api/events/${ev.id}/teams`).send({ name: 'Alpha' })).body;
    return { app, db, coord, ev, team };
  }

  test('coordinator can create a team', async () => {
    const { team } = await makeEventAndTeam();
    expect(team.name).toBe('Alpha');
    expect(team.members).toEqual([]);
  });

  test('first_aider cannot create a team', async () => {
    const { app, ev } = await makeEventAndTeam();
    const fa = await loginAs(app, 'firstaid1', 'firstaid123');
    await fa.post(`/api/events/${ev.id}/teams`).send({ name: 'X' }).expect(403);
  });

  test('coordinator can add a first aider to a team', async () => {
    const { app, coord, ev, team, db } = await makeEventAndTeam();
    const faUser = db.prepare("SELECT id FROM users WHERE username = 'firstaid1'").get();
    await coord.post(`/api/teams/${team.id}/members`).send({ userId: faUser.id }).expect(200);

    const teams = (await coord.get(`/api/events/${ev.id}/teams`)).body;
    expect(teams[0].members.length).toBe(1);
    expect(teams[0].members[0].username).toBe('firstaid1');
  });

  test('coordinator can remove a member from a team', async () => {
    const { app, coord, ev, team, db } = await makeEventAndTeam();
    const faUser = db.prepare("SELECT id FROM users WHERE username = 'firstaid1'").get();
    await coord.post(`/api/teams/${team.id}/members`).send({ userId: faUser.id });
    await coord.delete(`/api/teams/${team.id}/members/${faUser.id}`).expect(200);

    const teams = (await coord.get(`/api/events/${ev.id}/teams`)).body;
    expect(teams[0].members.length).toBe(0);
  });

  test('coordinator can delete a team', async () => {
    const { coord, ev, team } = await makeEventAndTeam();
    await coord.delete(`/api/events/${ev.id}/teams/${team.id}`).expect(200);
    const teams = (await coord.get(`/api/events/${ev.id}/teams`)).body;
    expect(teams.length).toBe(0);
  });
});

// ── Patients ─────────────────────────────────────────────────────────────────
describe('Patients', () => {
  async function makeScenario() {
    const { app, db } = setup();
    const coord   = await loginAs(app, 'coordinator', 'coordinator123');
    const fa1     = await loginAs(app, 'firstaid1',   'firstaid123');
    const ev      = (await coord.post('/api/events').send({ name: 'E', date: '2026-01-01' })).body;
    const team    = (await coord.post(`/api/events/${ev.id}/teams`).send({ name: 'Alpha' })).body;
    const faUser  = db.prepare("SELECT id FROM users WHERE username = 'firstaid1'").get();
    await coord.post(`/api/teams/${team.id}/members`).send({ userId: faUser.id });
    return { app, db, coord, fa1, ev, team, faUserId: faUser.id };
  }

  test('coordinator can register a patient', async () => {
    const { coord, ev } = await makeScenario();
    const res = await coord
      .post(`/api/events/${ev.id}/patients`)
      .send({
        location_description: 'Near finish line',
        incident_type:        'Heat Exhaustion',
        triage_level:         'yellow',
      })
      .expect(201);
    expect(res.body.triage_level).toBe('yellow');
    expect(res.body.status).toBe('waiting');
    expect(res.body.team_id).toBeNull();
  });

  test('patient registration requires all required fields', async () => {
    const { coord, ev } = await makeScenario();
    await coord.post(`/api/events/${ev.id}/patients`).send({ triage_level: 'red' }).expect(400);
  });

  test('invalid triage_level is rejected', async () => {
    const { coord, ev } = await makeScenario();
    await coord
      .post(`/api/events/${ev.id}/patients`)
      .send({ location_description: 'A', incident_type: 'B', triage_level: 'purple' })
      .expect(400);
  });

  test('patient assigned to team gets status=assigned', async () => {
    const { coord, ev, team } = await makeScenario();
    const res = await coord
      .post(`/api/events/${ev.id}/patients`)
      .send({
        location_description: 'Start area',
        incident_type:        'Fracture',
        triage_level:         'red',
        team_id:              team.id,
      })
      .expect(201);
    expect(res.body.status).toBe('assigned');
    expect(res.body.team_id).toBe(team.id);
  });

  test('coordinator can update triage level', async () => {
    const { coord, ev } = await makeScenario();
    const p = (await coord.post(`/api/events/${ev.id}/patients`).send({
      location_description: 'A', incident_type: 'B', triage_level: 'green',
    })).body;
    const updated = (await coord.put(`/api/patients/${p.id}`).send({ triage_level: 'red' })).body;
    expect(updated.triage_level).toBe('red');
  });

  test('coordinator can assign team and mark treated', async () => {
    const { coord, ev, team } = await makeScenario();
    const p = (await coord.post(`/api/events/${ev.id}/patients`).send({
      location_description: 'A', incident_type: 'B', triage_level: 'green',
    })).body;
    const assigned = (await coord.put(`/api/patients/${p.id}`).send({ team_id: team.id })).body;
    expect(assigned.status).toBe('assigned');
    const treated  = (await coord.put(`/api/patients/${p.id}`).send({ status: 'treated' })).body;
    expect(treated.status).toBe('treated');
  });

  test('coordinator can delete a patient', async () => {
    const { coord, ev } = await makeScenario();
    const p = (await coord.post(`/api/events/${ev.id}/patients`).send({
      location_description: 'A', incident_type: 'B', triage_level: 'green',
    })).body;
    await coord.delete(`/api/patients/${p.id}`).expect(200);
    const patients = (await coord.get(`/api/events/${ev.id}/patients`)).body;
    expect(patients.find(x => x.id === p.id)).toBeUndefined();
  });

  test('first_aider cannot register or modify patients', async () => {
    const { fa1, ev } = await makeScenario();
    await fa1.post(`/api/events/${ev.id}/patients`)
      .send({ location_description: 'A', incident_type: 'B', triage_level: 'red' })
      .expect(403);
  });

  test('first_aider sees only patients assigned to their team', async () => {
    const { coord, fa1, ev, team } = await makeScenario();

    // Patient for our team
    const p1 = (await coord.post(`/api/events/${ev.id}/patients`).send({
      location_description: 'A', incident_type: 'B', triage_level: 'red', team_id: team.id,
    })).body;

    // Patient NOT assigned to any team
    await coord.post(`/api/events/${ev.id}/patients`).send({
      location_description: 'C', incident_type: 'D', triage_level: 'green',
    });

    const patients = (await fa1.get(`/api/events/${ev.id}/patients`)).body;
    expect(patients.length).toBe(1);
    expect(patients[0].id).toBe(p1.id);
  });

  test('patients are sorted red → yellow → green', async () => {
    const { coord, ev } = await makeScenario();
    for (const level of ['green', 'yellow', 'red']) {
      await coord.post(`/api/events/${ev.id}/patients`).send({
        location_description: 'X', incident_type: 'Y', triage_level: level,
      });
    }
    const patients = (await coord.get(`/api/events/${ev.id}/patients`)).body;
    expect(patients.map(p => p.triage_level)).toEqual(['red', 'yellow', 'green']);
  });
});

// ── First aiders listing ──────────────────────────────────────────────────────
describe('Users', () => {
  test('coordinator can list first aiders', async () => {
    const { app } = setup();
    const coord = await loginAs(app, 'coordinator', 'coordinator123');
    const res   = await coord.get('/api/users/first-aiders').expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
    expect(res.body[0]).toHaveProperty('username');
    expect(res.body[0]).not.toHaveProperty('password_hash');
  });

  test('first_aider cannot list first aiders', async () => {
    const { app } = setup();
    const fa = await loginAs(app, 'firstaid1', 'firstaid123');
    await fa.get('/api/users/first-aiders').expect(403);
  });
});
