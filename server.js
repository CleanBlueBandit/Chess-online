//#region Imports
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { sendPublic } from './helpers.js';
import authRouter from './routes/auth.js';
import session from 'express-session';
import pagesRouter from './routes/pages.js';
import { authenticate, requestLogger } from './routes/middleware.js';
import srcRouter from './routes/resources.js';
import gamesRouter from './routes/games.js';
import { initSocket } from './ws/socket.js';
//#endregion

//#region Middleware
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

app.use(requestLogger);

app.use(
    '/css/auth',
    authenticate,
    express.static(path.join(__dirname, 'private-assets/css'))
);

app.use(
    '/js/auth',
    authenticate,
    express.static(path.join(__dirname, 'private-assets/js'))
);

app.use(express.json());
app.use(cookieParser());

const sessionMiddleware = session({
    name: 'sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
});

app.use(sessionMiddleware);

initSocket(httpServer, sessionMiddleware);

//#endregion

//#region Routes
app.use('/src', srcRouter);
app.use('/auth', authRouter);
app.use('/', pagesRouter);
app.use('/games', gamesRouter);

app.get('/', (req, res) => {
    return res.sendFile(sendPublic('index.html'));
});
//#endregion

//#region Server
let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n${signal} received. Shutting down server...`);

    // Prevent the process from hanging indefinitely.
    const timeout = setTimeout(() => {
        console.error('Shutdown timed out. Forcing exit.');
        process.exit(1);
    }, 10000);

    try {
        // Stop accepting connections and close Socket.IO clients.
        await new Promise((resolve, reject) => {
            io.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Delete every game from the database.
        const result = await prisma.game.deleteMany({});

        console.log(`Deleted ${result.count} games.`);

        await prisma.$disconnect();

        clearTimeout(timeout);
        console.log('Server shut down successfully.');

        process.exit(0);
    } catch (error) {
        clearTimeout(timeout);
        console.error('Error during shutdown:', error);

        await prisma.$disconnect().catch(() => {});
        process.exit(1);
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGKILL', () => {
    console.log("FATAL ERROR: SIGKILL received, server shutting down unexpectedly");
});

const baseUrl = `${process.env.PROTOCOL}://${process.env.HOSTNAME}:${process.env.PORT}`;

httpServer.listen(process.env.PORT, () => {
    console.log(`Server listening at ${baseUrl}`);
});
//#endregion
