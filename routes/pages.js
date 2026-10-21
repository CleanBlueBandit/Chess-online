import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticate } from './middleware.js';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pagesDirAuth = path.join(__dirname, '../', 'private-assets', 'images');
const pagesDir = path.join(__dirname, '../', 'public', 'images');


router.get("/", (req, res) => {
    
})

router.get('/dashboard', authenticate, (req, res) => {
    res.sendFile(path.join(pagesDirAuth, 'dashboard.html'));
});


export default router;