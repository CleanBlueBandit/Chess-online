import express from 'express';
import { sendResource, fileExists } from '../helpers.js';
import { authenticate } from './middleware.js';

const router = express.Router();

router.get('/{*path}', (req, res, next) => {
    const resource = req.path.replace(/^\/+/, '');
    const publicPath = sendResource(`public/${resource}`);
    const authenticatedPath = sendResource(`authenticated/${resource}`);

    if (fileExists(publicPath)) {
        return res.sendFile(publicPath);
    }

    if (fileExists(authenticatedPath)) {
        return authenticate(req, res, () => {
            res.sendFile(authenticatedPath);
        });
    }

    return res.sendStatus(404);
});

export default router;