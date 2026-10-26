# Chess Online

A web app for playing chess online. Players register, log in, and are matched with an opponent in real time. Matchmaking, authentication, and real-time notifications are in place; the chess board and move logic are not built yet (see [Status](#status)).

## Features

- **Accounts**: registration and login with bcrypt-hashed passwords, session cookies, and rate limiting
- **Matchmaking**: first-come, first-served queue backed by PostgreSQL with race-safe pairing (`SERIALIZABLE` transaction + `FOR UPDATE SKIP LOCKED`)
- **Real-time events**: Socket.IO notifies both players the moment a match is found
- **Security basics**: `helmet`, `httpOnly`/`sameSite` cookies, session regeneration on login (anti-fixation), constant-time login checks (anti user-enumeration)
- **Request logging**: colorized request/response logs with timing

## Tech Stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js (ES modules) |
| Server | Express 5 |
| Real-time | Socket.IO 4 |
| Database | PostgreSQL via Prisma 7 (`@prisma/adapter-pg`) |
| Auth | `express-session`, `bcrypt` |
| Frontend | Static HTML, CSS, and vanilla JS |

## Project Structure

```
.
├── server.js                 # App entry point: middleware, routes, graceful shutdown
├── helpers.js                # Path helpers for public/private HTML and resources
├── db/prisma.js              # Prisma client (PostgreSQL adapter)
├── prisma/
│   ├── schema.prisma         # User and Game models
│   └── migrations/           # SQL migrations
├── prisma7.config.ts         # Prisma config (schema path, migrations, DATABASE_URL)
├── routes/
│   ├── auth.js               # POST /auth/register, /auth/login, /auth/logout
│   ├── games.js              # POST /games/start, /games/cancel; GET /games/game/:id
│   ├── pages.js              # Page routes: /, /login, /register, /dashboard, /coffee
│   ├── resources.js          # Serves /src/* (public + authenticated static files)
│   └── middleware.js         # authenticate, authenticateReturn, requestLogger
├── ws/socket.js              # Socket.IO setup, session-based auth, match_found event
├── error/errorpage.js        # Styled HTTP error pages
├── images/
│   ├── public/               # index, login, register HTML
│   └── authenticated/        # dashboard, game HTML
└── resources/
    ├── public/               # style.css, error.css, login.js, register.js
    └── authenticated/        # dashboard.js
```

## Getting Started

### Prerequisites

- Node.js 20+ (Prisma 7 requires a recent version)
- A running PostgreSQL database

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create a `.env` file in the project root:

```env
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/chess"
SESSION_SECRET="a-long-random-string"
PROTOCOL=http
HOSTNAME=localhost
PORT=3000
NODE_ENV=development
```

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Secret used to sign session cookies |
| `PROTOCOL`, `HOSTNAME`, `PORT` | Used for the listen port and the startup log URL |
| `NODE_ENV` | Set to `production` to mark session cookies `secure` (requires HTTPS) |

### 3. Set up the database

The Prisma config file is named `prisma7.config.ts` (not the default `prisma.config.ts`), so pass it explicitly:

```bash
npx prisma generate --config prisma7.config.ts
npx prisma migrate deploy --config prisma7.config.ts
```

`generate` creates the client in `generated/prisma/`, which is git-ignored and imported by `db/prisma.js`.

### 4. Run

```bash
npm run dev      # nodemon, restarts on changes
# or
node server.js
```

Then open `http://localhost:3000`.

## How It Works

1. A user registers or logs in at `/register` or `/login`. A session cookie (`sid`) is issued.
2. On `/dashboard`, **Find opponent** calls `POST /games/start`.
3. The server either joins the oldest waiting game or creates a new one in the `waiting` state.
4. When a second player joins, the game becomes `active` and a `match_found` Socket.IO event is sent to both players' private rooms (`user:<id>`).
5. Both clients redirect to `/games/game/:id`.

Players can leave the queue with **Cancel search** (`POST /games/cancel`).

## API Reference

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/register` | No | Create an account (`username`: 3-20 chars of letters, numbers, `_`, `-`; `password`: 8-72 bytes). Limit: 5/hour |
| POST | `/auth/login` | No | Log in. Limit: 10 failed attempts per 15 min |
| POST | `/auth/logout` | Session | Destroy the session |
| POST | `/games/start` | Session | Join the queue or get matched. Limit: 10/min |
| POST | `/games/cancel` | Session | Leave the queue. Limit: 10/min |
| GET | `/games/game/:id` | Session | Game page |
| GET | `/dashboard` | Session | Matchmaking page |

**Socket.IO event** (server to client): `match_found` with `{ gameId, player1Id, player2Id }`. Connections without a valid session are rejected with `Unauthorized`.

## Data Model

- **User**: `id`, `username` (unique), `passwordHash`, `Elo` (default 100)
- **Game**: `id`, `state` (`waiting` | `active`), `player1Id`, `player2Id`, `createTime`, `startTime`, `endTime`
