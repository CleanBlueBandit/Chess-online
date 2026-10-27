import { Server } from 'socket.io';
import { registerGameHandlers } from './gameSocket.js';

export let io;

export function initSocket(httpServer, sessionMiddleware) {
    io = new Server(httpServer);

    io.use((socket, next) => {
        sessionMiddleware(socket.request, {}, (err) => {
            if (err) return next(err);

            const userId = socket.request.session?.userId;

            if (!userId) {
                return next(new Error('Unauthorized'));
            }

            socket.data.userId = userId;
            next();
        });
    });

    io.on('connection', (socket) => {
        socket.join(`user:${socket.data.userId}`);
        registerGameHandlers(io, socket);

        console.log(`Socket connected for user ${socket.data.userId}`);

        socket.on('disconnect', () => {
            console.log(`Socket disconnected for user ${socket.data.userId}`);
        });
    });

    return io;
}

export function notifyMatchFound(game) {
    if (!io) {
        throw new Error('Socket.IO has not been initialized');
    }

    const data = {
        gameId: game.id,
        player1Id: game.player1Id,
        player2Id: game.player2Id
    };

    io.to(`user:${game.player1Id}`).emit('match_found', data);
    io.to(`user:${game.player2Id}`).emit('match_found', data);
}
