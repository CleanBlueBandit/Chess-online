/*
 * Socket.IO glue between the game page and ChessGame.
 *
 * Client -> server
 *   'join' (gameId)   subscribe to a game; answered with a "state" message
 *   'msg'  (object)   {type:"move"|"abort"|"resign"|"draw_offer"|"draw_accept"|
 *                      "draw_decline"|"sync", ...}
 *
 * Server -> client
 *   'msg'  (object)   {type:"state"|"move"|"move_rejected"|"draw_offered"|
 *                      "draw_declined"|"game_over"|"error", ...}
 *
 * The message shapes are documented at the top of resources/authenticated/game.js.
 */
import { getGame, getOrLoadGame } from '../game/manager.js';

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 60;

const room = (gameId) => `game:${gameId}`;
const wired = new WeakSet();

/** Broadcast "game_over" to a game's room, once per game object. */
function wireGame(io, game) {
    if (wired.has(game)) return;
    wired.add(game);

    game.on('over', ({ result, reason, clocks }) => {
        io.to(room(game.id)).emit('msg', { type: 'game_over', result, reason, clocks });
    });
}

export function registerGameHandlers(io, socket) {
    const userId = socket.data.userId;
    let recent = [];

    const reply = (payload) => socket.emit('msg', payload);
    const toRoom = (game, payload) => io.to(room(game.id)).emit('msg', payload);

    const rateLimited = () => {
        const now = Date.now();
        recent = recent.filter((t) => now - t < RATE_WINDOW_MS);
        if (recent.length >= RATE_MAX_MESSAGES) return true;
        recent.push(now);
        return false;
    };

    socket.on('join', async (gameId) => {
        if (typeof gameId !== 'string' || gameId.length === 0 || gameId.length > 64) {
            return reply({ type: 'error', message: 'Invalid game.', fatal: true });
        }

        try {
            const game = await getOrLoadGame(gameId);
            if (!game) {
                return reply({ type: 'error', message: 'This game does not exist or has not started.', fatal: true });
            }

            wireGame(io, game);

            const previous = socket.data.gameId;
            if (previous && previous !== gameId) socket.leave(room(previous));

            socket.data.gameId = gameId;
            socket.join(room(gameId));
            reply(game.snapshot(game.colorOf(userId)));
        } catch (err) {
            console.error('Failed to join game:', err);
            reply({ type: 'error', message: 'Could not load the game.' });
        }
    });

    socket.on('msg', (msg) => {
        if (rateLimited()) {
            return reply({ type: 'error', message: 'You are sending messages too quickly.' });
        }
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

        const game = socket.data.gameId ? getGame(socket.data.gameId) : null;
        if (!game) {
            return reply({ type: 'error', message: 'You have not joined a game.', fatal: true });
        }

        const myColor = game.colorOf(userId);

        // A rejected request also resends the real state so the client can
        // undo anything it showed optimistically.
        const reject = (reason) => {
            reply({ type: 'error', message: reason });
            reply(game.snapshot(myColor));
        };

        switch (msg.type) {
            case 'move': {
                const r = game.move(userId, {
                    from: msg.from,
                    to: msg.to,
                    promotion: msg.promotion,
                    ply: msg.ply
                });
                if (!r.ok) {
                    return reply({
                        type: 'move_rejected',
                        reason: r.reason,
                        state: game.snapshot(myColor)
                    });
                }
                // Goes to both players; for the mover it doubles as the ack.
                toRoom(game, {
                    type: 'move',
                    ply: r.ply,
                    san: r.san,
                    clocks: r.clocks,
                    running: r.running
                });
                break;
            }

            case 'abort': {
                const r = game.abort(userId);
                if (!r.ok) reject(r.reason); // success is announced by "game_over"
                break;
            }

            case 'resign': {
                const r = game.resign(userId);
                if (!r.ok) reject(r.reason);
                break;
            }

            case 'draw_offer': {
                const r = game.offerDraw(userId);
                if (!r.ok) return reject(r.reason);
                if (!r.accepted) toRoom(game, { type: 'draw_offered', by: r.by });
                break;
            }

            case 'draw_accept': {
                const r = game.acceptDraw(userId);
                if (!r.ok) reject(r.reason);
                break;
            }

            case 'draw_decline': {
                const r = game.declineDraw(userId);
                if (!r.ok) return reject(r.reason);
                // Tell whoever made the offer.
                io.to(`user:${game.players[r.by].id}`).emit('msg', { type: 'draw_declined' });
                break;
            }

            case 'sync':
                reply(game.snapshot(myColor));
                break;

            default:
                reply({ type: 'error', message: 'Unknown message.' });
        }
    });
}
