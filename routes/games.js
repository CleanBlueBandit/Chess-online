import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../db/prisma.js';
import { authenticateReturn, authenticate } from './middleware.js';
import { notifyMatchFound } from '../ws/socket.js';
import { errorPage, errorStatusCode, respondWithStatusCode } from '../error/errorpage.js';

const router = Router();

const startLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        ok: false,
        message: 'Too many game start attempts, try again later.'
    }
});

const cancelLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        ok: false,
        message: 'Too many cancel attempts, try again later.'
    }
});

const gameLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 50,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        ok: false,
        message: 'Too many game access attempts, try again later'
    }
});

async function findOrCreateGame(userId) {
    return prisma.$transaction(async (tx) => {
        const existingGame = await tx.game.findFirst({
            where: {
                state: { in: ['waiting', 'active'] },
                OR: [
                    { player1Id: userId },
                    { player2Id: userId }
                ]
            }
        });

        if (existingGame) {
            return {
                game: existingGame,
                created: false,
                alreadyInGame: true
            };
        }

        const waitingGames = await tx.$queryRaw`
            SELECT "id", "player1Id"
            FROM "Game"
            WHERE "state" = 'waiting'
              AND "player2Id" IS NULL
              AND "player1Id" IS NOT NULL
              AND "player1Id" <> ${userId}
            ORDER BY "createTime" ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        `;

        if (waitingGames.length > 0) {
            const waitingGame = waitingGames[0];

            const claimed = await tx.game.updateMany({
                where: {
                    id: waitingGame.id,
                    state: 'waiting',
                    player2Id: null
                },
                data: {
                    player2Id: userId,
                    state: 'active',
                    startTime: new Date()
                }
            });

            if (claimed.count === 1) {
                const game = await tx.game.findUniqueOrThrow({
                    where: { id: waitingGame.id }
                });

                return {
                    game,
                    created: false,
                    alreadyInGame: false
                };
            }
        }

        const game = await tx.game.create({
            data: {
                player1Id: userId,
                state: 'waiting'
            }
        });

        return {
            game,
            created: true,
            alreadyInGame: false
        };
    }, {
        isolationLevel: 'Serializable',
        timeout: 5000
    });
}

router.post('/start', startLimiter, authenticateReturn, async (req, res) => {
    try {
        const result = await findOrCreateGame(req.user.id);

        if (result.alreadyInGame) {
            return res.status(200).json({
                ok: true,
                message: 'You are already in a game.',
                game: result.game
            });
        }

        // Notify both players only when a new match has been formed.
        if (!result.created && result.game.state === 'active') {
            notifyMatchFound(result.game);
        }

        return res.status(200).json({
            ok: true,
            message: result.created
                ? 'Waiting for an opponent.'
                : 'Match found.',
            game: result.game
        });
    } catch (error) {
        if (error?.code === 'P2034') {
            return res.status(409).json({
                ok: false,
                message: 'Matchmaking conflict. Please try again.'
            });
        }

        console.error('Matchmaking error:', error);

        return res.status(500).json({
            ok: false,
            message: 'Failed to start matchmaking.'
        });
    }
});

router.post('/cancel', cancelLimiter, authenticateReturn, async (req, res) => {
    try {
        const deleted = await prisma.game.deleteMany({
            where: {
                player1Id: req.user.id,
                player2Id: null,
                state: 'waiting'
            }
        });

        if (deleted.count > 0) {
            return res.status(200).json({
                ok: true,
                cancelled: true,
                message: 'Matchmaking cancelled.'
            });
        }


        const activeGame = await prisma.game.findFirst({
            where: {
                state: 'active',
                OR: [
                    { player1Id: req.user.id },
                    { player2Id: req.user.id }
                ]
            }
        });

        if (activeGame) {
            return res.status(409).json({
                ok: false,
                message: 'Your match has already started.',
                game: activeGame
            });
        }

        return res.status(200).json({
            ok: true,
            cancelled: false,
            message: 'You are not searching for a game.'
        });
    } catch (error) {
        console.error('Cancel matchmaking error:', error);

        return res.status(500).json({
            ok: false,
            message: 'Failed to cancel matchmaking.'
        });
    }
});


router.get("/game/:id", gameLimiter, authenticate, async (req, res) => {
    try {
        const game = await prisma.game.findUniqueOrThrow({
            where: { id: req.params.id }
        });
        return respondWithStatusCode(506, res);
    } 
    catch (err) {
        if (err.code === 'P2025') {
            return respondWithStatusCode(404, res);
        }
        throw err;
    }
})

export default router;