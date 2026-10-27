/*
 * Registry of live games.
 *
 * Matchmaking (routes/games.js) creates an 'active' Game row. The first time
 * somebody opens that game we build a ChessGame for it here and keep it in
 * memory. When it ends we update both players' Elo and delete the row (the
 * Game model has unique player columns, so a finished row would otherwise
 * block both players from ever starting another game). The finished game stays
 * in memory for a while so a reload or late reconnect still shows the result.
 */
import prisma from '../db/prisma.js';
import { calculateElo } from '../helpers.js';
import { ChessGame } from './game.js';

const FINISHED_TTL_MS = 10 * 60 * 1000;

const games = new Map();   // gameId -> ChessGame
const loading = new Map(); // gameId -> Promise<ChessGame | null>

export function getGame(gameId) {
    return games.get(gameId) ?? null;
}

/** Returns the live game, loading it from the database if needed. */
export function getOrLoadGame(gameId) {
    const existing = games.get(gameId);
    if (existing) return Promise.resolve(existing);

    if (!loading.has(gameId)) {
        const promise = loadGame(gameId).finally(() => loading.delete(gameId));
        loading.set(gameId, promise);
    }
    return loading.get(gameId);
}

async function loadGame(gameId) {
    const row = await prisma.game.findUnique({
        where: { id: gameId },
        include: { player1: true, player2: true }
    });

    if (!row || row.state !== 'active' || !row.player1 || !row.player2) {
        return null;
    }

    const [white, black] = Math.random() < 0.5
        ? [row.player1, row.player2]
        : [row.player2, row.player1];

    const toPlayer = (user) => ({ id: user.id, name: user.username, rating: user.Elo });

    const game = new ChessGame({
        id: gameId,
        white: toPlayer(white),
        black: toPlayer(black)
    });

    game.once('over', (outcome) => {
        finalize(game, outcome).catch((err) => {
            console.error(`Failed to finalize game ${gameId}:`, err);
        });
    });

    games.set(gameId, game);
    return game;
}

async function finalize(game, { result }) {
    const evict = setTimeout(() => {
        game.dispose();
        games.delete(game.id);
    }, FINISHED_TTL_MS);
    evict.unref?.();

    try {
        await persistResult(game, result);
    } catch (err) {
        console.error(`Rating update failed for game ${game.id}:`, err);
        // Never leave the row behind: it would lock both players out of new games.
        await prisma.game.deleteMany({ where: { id: game.id } });
    }
}

async function persistResult(game, result) {
    await prisma.$transaction(async (tx) => {
        // '*' means aborted: no rating change.
        if (result !== '*') {
            const white = await tx.user.findUniqueOrThrow({ where: { id: game.players.w.id } });
            const black = await tx.user.findUniqueOrThrow({ where: { id: game.players.b.id } });

            const whiteScore = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
            const { ratingA, ratingB } = calculateElo(white.Elo, black.Elo, whiteScore);

            await tx.user.update({ where: { id: white.id }, data: { Elo: ratingA } });
            await tx.user.update({ where: { id: black.id }, data: { Elo: ratingB } });
        }

        await tx.game.deleteMany({ where: { id: game.id } });
    });
}

/** Stop every timer. Used during server shutdown. */
export function disposeAllGames() {
    for (const game of games.values()) game.dispose();
    games.clear();
}
