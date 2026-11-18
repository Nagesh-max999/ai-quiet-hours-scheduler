import jwt from 'jsonwebtoken';

const DEV_SECRET = 'dev-only-secret-change-me';

export function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  return secret || DEV_SECRET;
}

export function signToken(user) {
  return jwt.sign({ sub: user.id }, jwtSecret(), { expiresIn: '7d' });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, jwtSecret()).sub;
  } catch {
    return null;
  }
}

/** Express middleware: requires `Authorization: Bearer <jwt>`. */
export function requireAuth(store) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const userId = token && verifyToken(token);
    const user = userId && store.findUserById(userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    next();
  };
}

export function publicUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}
