//#region Imports
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import 'dotenv/config';
import { sendPublic } from './helpers.js';
import authRouter from './routes/auth.js';
import session from 'express-session';
import pagesRouter from './routes/pages.js';
import { authenticate, requestLogger } from './routes/middleware.js';
//#endregion

//#region Middleware
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(requestLogger);
app.use('/css/auth', authenticate, express.static(path.join(__dirname, 'private-assets/css')));
app.use('/js/auth', authenticate, express.static(path.join(__dirname, 'private-assets/js')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));
app.use('/css', express.static(path.join(__dirname, 'public/css')));



app.use(express.json());
app.use(cookieParser());

app.use(session({
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
}));

app.use('/auth', authRouter);
app.use('/', pagesRouter);


const baseUrl = `${process.env.PROTOCOL}://${process.env.HOSTNAME}:${process.env.PORT}`
httpServer.listen(process.env.PORT, () => {
    console.log(`Server listening at ${baseUrl}`);
})

//#endregion


app.get("/", (req, res) => {
    return res.sendFile(sendPublic("index.html"));
})
