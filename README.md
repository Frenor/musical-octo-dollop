# Red Cross Event Coordinator

A simple, reliable patient coordination system for Red Cross events. Coordinators register incoming patients, triage them (🔴 red / 🟡 yellow / 🟢 green), and assign them to first-aider teams. First aiders see their assigned patients in real time on any mobile device.

## Features

- **Multiple parallel events** — coordinators and first aiders each work on one event at a time
- **Patient registration** — textual location description and incident type (with autocomplete suggestions)
- **Triage** — red / yellow / green priority, colour-coded throughout the UI
- **Team management** — create teams, assign first aiders, assign patients to teams
- **Real-time updates** — first aiders instantly see new or updated assignments (Socket.io)
- **Mobile-friendly** — first-aider view is optimised for smartphones
- **Role-based access** — coordinators can edit everything; first aiders see only their team's patients
- **No external database** — uses the built-in Node.js SQLite module (Node ≥ 22)

## Roles

| Role | Can do |
|------|--------|
| `coordinator` | Create/manage events, register & triage patients, manage teams, assign patients to teams |
| `first_aider` | View patients assigned to their team |

## Quick start

```bash
npm install
npm start
# open http://localhost:3000
```

Default accounts created on first run:

| Username | Password | Role |
|----------|----------|------|
| `coordinator` | `coordinator123` | Coordinator |
| `firstaid1` | `firstaid123` | First Aider |
| `firstaid2` | `firstaid123` | First Aider |
| `firstaid3` | `firstaid123` | First Aider |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data.db` | Path to the SQLite database file |
| `SESSION_SECRET` | *(dev default)* | Session secret – **change in production** |

## Running tests

```bash
npm test
```

## Project structure

```
server.js          Express + Socket.io server (all API routes)
public/
  login.html       Login page
  events.html      Event list / creation / selection
  coordinator.html Coordinator dashboard (patients + teams)
  firstaid.html    First-aider mobile view
  style.css        Shared responsive styles
tests/
  api.test.js      API integration tests (30 tests)
```