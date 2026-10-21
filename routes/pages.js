import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticate } from './middleware.js';
import { sendPrivate, sendPublic } from '../helpers.js';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



router.get("/", (req, res) => {
    res.sendFile(sendPublic("images/index.html"));
})

router.get('/dashboard', authenticate, (req, res) => {
    res.sendFile(sendPrivate("images/dashboard.html"));
});

router.get("/login", (req, res) => {
    res.sendFile(sendPublic("images/login.html"));
})

router.get("/register", (req, res) => {
    res.sendFile(sendPublic("images/register.html"));
})


export default router;