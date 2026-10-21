import { Router } from 'express';
import bcrypt from 'bcrypt';
import prisma from '../db/prisma.js';

const router = Router();


router.post('/register', async (req, res, next) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                error: 'Username and password are required'
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const user = await prisma.user.create({
            data: { username, passwordHash },
            select: { id: true, username: true }
        });

        res.status(201).json(user);
    } catch (err) {
        if (err.code === 'P2002') {
            return res.status(409).json({
                error: 'Username already exists'
            });
        }

        next(err);
    }
});

router.post('/login', async (req, res, next) => {
    try {
        const { username, password } = req.body;

        const user = await prisma.user.findUnique({
            where: { username }
        });

        if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
            return res.status(401).json({
                error: 'Invalid username or password'
            });
        }

        req.session.regenerate((err) => {
            if (err) return next(err);

            req.session.userId = user.id;

            req.session.save((err) => {
                if (err) return next(err);

                res.json({
                    success: true,
                    user: {
                        id: user.id,
                        username: user.username
                    }
                });
            });
        });
    } catch (err) {
        next(err);
    }
});

export default router;
