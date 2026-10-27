# Chess Online

A web app for playing chess online. Players register, log in, and are matched with an opponent in real time. Matchmaking, authentication, and real-time play (server-validated moves, clocks, draws, resignation, Elo) are in place.

## Features

- **Accounts**: registration and login with bcrypt-hashed passwords, session cookies, and rate limiting
- **Matchmaking**: first-come, first-served queue backed by PostgreSQL with race-safe pairing (`SERIALIZABLE` transaction + `FOR UPDATE SKIP LOCKED`)
- **Real-time events**: Socket.IO notifies both players the moment a match is found
- **Live games**: the server validates every move with `chess.js`, runs the clocks, detects checkmate, stalemate, repetition, fifty-move and insufficient-material draws, timeouts, resignation, aborts and draw offers, and updates Elo when a game ends
- **Security basics**: `httpOnly`/`sameSite` cookies, session regeneration on login (anti-fixation), constant-time login checks (anti user-enumeration)
- **Request logging**: colorized request/response logs with timing

## Tech Stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js (ES modules) |
| Server | Express 5 |
| Real-time | Socket.IO 4 |
| Database | PostgreSQL via Prisma 7 (`@prisma/adapter-pg`) |
| Auth | `express-session`, `bcrypt` |
| Chess rules | `chess.js` (server-side validation; also loaded in the browser from a CDN) |
| Frontend | Static HTML, CSS, and vanilla JS |

## Project Structure

```
.
├── server.js                 # App entry point: middleware, routes, graceful shutdown
├── helpers.js                # Path helpers, Elo calculation
├── game/
│   ├── game.js               # ChessGame: move validation, clocks, draws, game end (no I/O)
│   └── manager.js            # Live-game registry, DB loading, Elo + cleanup on game end
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
├── ws/
│   ├── socket.js             # Socket.IO setup, session-based auth, match_found event
│   └── gameSocket.js         # In-game Socket.IO protocol (join, move, resign, draws, ...)
├── error/errorpage.js        # Styled HTTP error pages
├── images/
│   ├── public/               # index, login, register HTML
│   └── authenticated/        # dashboard, game HTML
└── resources/
    ├── public/               # style.css, error.css, login.js, register.js
    └── authenticated/        # dashboard.js, game.js, game.css
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
| `GAME_TIME_MS` | Optional. Time per side in ms (default 600000) |
| `GAME_INCREMENT_MS` | Optional. Increment per move in ms (default 0) |
| `GAME_FIRST_MOVE_TIMEOUT_MS` | Optional. Abort if a side doesn't make its first move in time (default 60000) |

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
6. The game page connects over Socket.IO and sends `join`. The server builds a `ChessGame` for the row (colors are assigned randomly), replies with a `state` message, and from then on validates every `move`. Moves, draw offers, and `game_over` are broadcast to both players (and any spectators).
7. When the game ends, both Elo ratings are updated (not for aborts) and the `Game` row is deleted so both players can queue again. The finished game stays in memory for 10 minutes so reloads still show the result.

The clocks start after both players have moved. If a player makes no first move within 60 seconds the game is aborted. Defaults: 10 minutes per side, no increment.

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

**In-game events**: the client emits `join` (gameId) and `msg` (`move`, `abort`, `resign`, `draw_offer`, `draw_accept`, `draw_decline`, `sync`); the server answers with `msg` events (`state`, `move`, `move_rejected`, `draw_offered`, `draw_declined`, `game_over`, `error`). The exact shapes are documented at the top of `resources/authenticated/game.js`.

## Game Protocol

All in-game traffic uses Socket.IO. The client emits `join` with the game id after every (re)connect; everything else is a JSON object sent on the `msg` event in both directions.

**Client to server**

| `type` | Fields | Notes |
| --- | --- | --- |
| `move` | `from`, `to`, `promotion?`, `ply` | `ply` must be the next move number; the server ignores any client-supplied position |
| `abort` | | Only before 2 plies have been played |
| `resign` | | |
| `draw_offer` | | Only after 2 plies. If the opponent already offered, this accepts |
| `draw_accept` / `draw_decline` | | Reply to the opponent's offer |
| `sync` | | Ask for a fresh `state` |

**Server to client**

| `type` | Sent to | Meaning |
| --- | --- | --- |
| `state` | The requester | Full snapshot: `color` (`w`, `b`, or `null` for spectators), `moves`, `players`, `clocks`, `running`, `drawOffer`, and `result`/`reason` once over |
| `move` | Everyone in the game | `ply`, `san`, `clocks`, `running`; doubles as the mover's acknowledgement |
| `move_rejected` | The mover | `reason` plus a corrected `state` |
| `draw_offered` / `draw_declined` | Everyone / the offerer | |
| `game_over` | Everyone | `result` (`1-0`, `0-1`, `1/2-1/2`, `*` for aborted), `reason`, final `clocks` |
| `error` | The requester | `message`; `fatal: true` sends the page back to the dashboard |

Game end reasons: `checkmate`, `stalemate`, `repetition`, `fifty-move rule`, `insufficient material`, `timeout`, `timeout vs insufficient material`, `resignation`, `agreement`, `aborted`.

## Data Model

- **User**: `id`, `username` (unique), `passwordHash`, `Elo` (default 100)
- **Game**: `id`, `state` (`waiting` | `active`), `player1Id`, `player2Id`, `createTime`, `startTime`, `endTime`

## Limitations

- Live games are held in server memory. If the server crashes mid-game, an unfinished game restarts from the initial position when reopened (a clean shutdown deletes all games).
- The `Game` model's unique player columns allow one game row per player, which is why finished games are deleted rather than archived. Keeping a game history would need a schema change.
