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
const baseUrl = `${process.env.PROTOCOL}://${process.env.HOSTNAME}:${process.env.PORT}`;

httpServer.listen(process.env.PORT, () => {
    console.log(`Server listening at ${baseUrl}`);
});
//#endregion
