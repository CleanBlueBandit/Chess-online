/*
 * ChessGame: the authoritative state of one live game.
 *
 * Pure game logic, no database and no sockets. It owns
 *   - move validation (chess.js) and turn/ply checks
 *   - the clocks (server time is the only time that counts)
 *   - resign / abort / draw offers
 *   - game-end detection (mate, stalemate, repetition, 50-move, material, flag)
 *
 * It emits a single event, 'over' ({ result, reason, clocks }), after the
 * method that ended the game has returned. Persistence lives in
 * game/manager.js and networking in ws/gameSocket.js.
 */
import { EventEmitter } from 'node:events';
import { Chess } from 'chess.js';

export const DEFAULT_TIME_MS = Number(process.env.GAME_TIME_MS) || 10 * 60 * 1000;
export const DEFAULT_INCREMENT_MS = Number(process.env.GAME_INCREMENT_MS) || 0;
export const FIRST_MOVE_TIMEOUT_MS = Number(process.env.GAME_FIRST_MOVE_TIMEOUT_MS) || 60 * 1000;

const SQUARE = /^[a-h][1-8]$/;
const PROMOTIONS = new Set(['q', 'r', 'b', 'n']);
const other = (color) => (color === 'w' ? 'b' : 'w');
const fail = (reason) => ({ ok: false, reason });

export class ChessGame extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.id
     * @param {{id:string,name:string,rating:number}} opts.white
     * @param {{id:string,name:string,rating:number}} opts.black
     */
    constructor({
        id,
        white,
        black,
        timeMs = DEFAULT_TIME_MS,
        incrementMs = DEFAULT_INCREMENT_MS,
        firstMoveTimeoutMs = FIRST_MOVE_TIMEOUT_MS
    }) {
        super();
        this.id = id;
        this.players = { w: white, b: black };
        this.chess = new Chess();
        this.sans = [];
        this.clocks = { w: timeMs, b: timeMs };
        this.incrementMs = incrementMs;
        this.firstMoveTimeoutMs = firstMoveTimeoutMs;

        // The clocks only start once both players have moved (like abort rules).
        this.running = false;
        this.lastTick = Date.now();

        this.drawOffer = null; // 'w' | 'b' | null
        this.result = null;    // '1-0' | '0-1' | '1/2-1/2' | '*' (aborted)
        this.reason = null;
        this.endedAt = null;

        this.timer = null;
        this.#schedule();
    }

    /* ---------------- Queries ---------------- */

    get over() { return this.result !== null; }
    get turn() { return this.chess.turn(); }
    get ply() { return this.sans.length; }

    colorOf(userId) {
        if (this.players.w.id === userId) return 'w';
        if (this.players.b.id === userId) return 'b';
        return null;
    }

    /** Remaining time for both sides right now, in whole milliseconds. */
    currentClocks() {
        const c = { w: this.clocks.w, b: this.clocks.b };
        if (this.running && !this.over) {
            c[this.turn] -= Date.now() - this.lastTick;
        }
        return { w: Math.max(0, Math.round(c.w)), b: Math.max(0, Math.round(c.b)) };
    }

    /** Full state message for one viewer (color null = spectator). */
    snapshot(forColor = null) {
        const p = this.players;
        const state = {
            type: 'state',
            color: forColor,
            moves: [...this.sans],
            players: {
                w: { name: p.w.name, rating: p.w.rating },
                b: { name: p.b.name, rating: p.b.rating }
            },
            clocks: this.currentClocks(),
            running: this.running && !this.over,
            drawOffer: this.drawOffer
        };
        if (this.over) {
            state.result = this.result;
            state.reason = this.reason;
        }
        return state;
    }

    /* ---------------- Moves ---------------- */

    /**
     * Validate and play a move for `userId`.
     * Returns { ok:true, ply, san, clocks, running } or { ok:false, reason }.
     * The client's own idea of the resulting position is never trusted.
     */
    move(userId, { from, to, promotion, ply } = {}) {
        if (this.over) return fail('The game is over.');

        const color = this.colorOf(userId);
        if (!color) return fail('You are not a player in this game.');
        if (color !== this.turn) return fail("It's not your turn.");

        if (typeof from !== 'string' || !SQUARE.test(from) ||
            typeof to !== 'string' || !SQUARE.test(to)) {
            return fail('Malformed move.');
        }
        if (promotion != null && !PROMOTIONS.has(promotion)) {
            return fail('Malformed move.');
        }
        if (ply !== undefined && ply !== this.ply + 1) {
            return fail('Your board was out of sync.');
        }

        // Flag check happens before the move is applied: a move that arrives
        // after the player's time ran out does not count.
        const now = Date.now();
        if (this.running) {
            const elapsed = now - this.lastTick;
            if (elapsed >= this.clocks[color]) {
                this.#timeout(color);
                return fail('You ran out of time.');
            }
            this.clocks[color] -= elapsed;
        }

        let mv;
        try {
            mv = this.chess.move({ from, to, promotion: promotion ?? undefined });
        } catch {
            return fail('Illegal move.');
        }

        this.sans.push(mv.san);
        this.drawOffer = null; // a move implicitly declines a pending offer
        if (this.running) this.clocks[color] += this.incrementMs;
        this.running = this.sans.length >= 2;
        this.lastTick = now;

        const end = this.#detectEnd(color);
        if (end) this.#finish(end.result, end.reason);
        else this.#schedule();

        return {
            ok: true,
            ply: this.ply,
            san: mv.san,
            clocks: this.currentClocks(),
            running: this.running && !this.over
        };
    }

    /* ---------------- Resign / abort / draws ---------------- */

    resign(userId) {
        const color = this.#player(userId);
        if (color.error) return color.error;
        this.#finish(color.value === 'w' ? '0-1' : '1-0', 'resignation');
        return { ok: true };
    }

    abort(userId) {
        const color = this.#player(userId);
        if (color.error) return color.error;
        if (this.ply >= 2) return fail('The game can no longer be aborted.');
        this.#finish('*', 'aborted');
        return { ok: true };
    }

    offerDraw(userId) {
        const color = this.#player(userId);
        if (color.error) return color.error;
        if (this.ply < 2) return fail("It's too early to offer a draw.");
        if (this.drawOffer === color.value) return fail('You already offered a draw.');

        // Both sides offering at once is an agreement.
        if (this.drawOffer === other(color.value)) {
            this.#finish('1/2-1/2', 'agreement');
            return { ok: true, accepted: true };
        }
        this.drawOffer = color.value;
        return { ok: true, accepted: false, by: color.value };
    }

    acceptDraw(userId) {
        const color = this.#player(userId);
        if (color.error) return color.error;
        if (this.drawOffer !== other(color.value)) return fail('There is no draw offer to accept.');
        this.#finish('1/2-1/2', 'agreement');
        return { ok: true };
    }

    declineDraw(userId) {
        const color = this.#player(userId);
        if (color.error) return color.error;
        if (this.drawOffer !== other(color.value)) return fail('There is no draw offer to decline.');
        const by = this.drawOffer;
        this.drawOffer = null;
        return { ok: true, by };
    }

    /** Stop timers (server shutdown / eviction). */
    dispose() {
        clearTimeout(this.timer);
        this.timer = null;
        this.removeAllListeners();
    }

    /* ---------------- Internals ---------------- */

    #player(userId) {
        if (this.over) return { error: fail('The game is over.') };
        const value = this.colorOf(userId);
        if (!value) return { error: fail('You are not a player in this game.') };
        return { value };
    }

    #detectEnd(mover) {
        const c = this.chess;
        if (c.isCheckmate()) return { result: mover === 'w' ? '1-0' : '0-1', reason: 'checkmate' };
        if (c.isStalemate()) return { result: '1/2-1/2', reason: 'stalemate' };
        if (c.isInsufficientMaterial()) return { result: '1/2-1/2', reason: 'insufficient material' };
        if (c.isThreefoldRepetition()) return { result: '1/2-1/2', reason: 'repetition' };
        if (c.isDraw()) return { result: '1/2-1/2', reason: 'fifty-move rule' };
        return null;
    }

    /** Can `color` still checkmate with what's on the board (rough FIDE rule)? */
    #hasMatingMaterial(color) {
        let minors = 0;
        for (const row of this.chess.board()) {
            for (const piece of row) {
                if (!piece || piece.color !== color) continue;
                if (piece.type === 'p' || piece.type === 'q' || piece.type === 'r') return true;
                if (piece.type === 'b' || piece.type === 'n') minors++;
            }
        }
        return minors >= 2;
    }

    #timeout(loser) {
        const winner = other(loser);
        if (!this.#hasMatingMaterial(winner)) {
            this.#finish('1/2-1/2', 'timeout vs insufficient material');
        } else {
            this.#finish(winner === 'w' ? '1-0' : '0-1', 'timeout');
        }
    }

    /** One timer: the flag of the side to move, or the first-move deadline. */
    #schedule() {
        clearTimeout(this.timer);
        this.timer = null;
        if (this.over) return;

        if (this.running) {
            const side = this.turn;
            const ms = Math.max(0, this.clocks[side] - (Date.now() - this.lastTick));
            this.timer = setTimeout(() => {
                if (!this.over && this.running && this.turn === side) this.#timeout(side);
            }, ms);
        } else {
            // Nobody moved in time before the clocks started: abort the game.
            const plyAtStart = this.ply;
            this.timer = setTimeout(() => {
                if (!this.over && this.ply === plyAtStart) this.#finish('*', 'aborted');
            }, this.firstMoveTimeoutMs);
        }
        this.timer.unref?.();
    }

    #finish(result, reason) {
        if (this.over) return;
        this.clocks = this.currentClocks(); // bake elapsed time before stopping
        this.running = false;
        this.result = result;
        this.reason = reason;
        this.drawOffer = null;
        this.endedAt = new Date();
        clearTimeout(this.timer);
        this.timer = null;

        const payload = { result, reason, clocks: { ...this.clocks } };
        // Deferred so callers can broadcast the final move before game_over.
        queueMicrotask(() => this.emit('over', payload));
    }
}
