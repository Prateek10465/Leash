// Multi-user local authentication and session engine for Leash.
// Zero-dependency, secure password hashing using node:crypto scrypt.
import crypto from 'node:crypto';

// Pre-seeded demo profiles for hackathon judges and testing.
const DEMO_PROFILES = [
  {
    id: 'usr_personal',
    name: 'Alex Rivera',
    email: 'alex@personal.example',
    role: 'Personal Shopper',
    avatar: 'AR',
    paypalConnected: true,
    paypalEmail: 'alex.rivera@sandbox.paypal.com',
    walletBalance: 250.0,
    policyText: 'Max $50 per purchase and $200 a month. Only electronics and books. Ask me before anything over $30. No transfers to people.',
  },
  {
    id: 'usr_enterprise',
    name: 'Acme Corp Procurement',
    email: 'procurement@acmecorp.example',
    role: 'Enterprise Team',
    avatar: 'AC',
    paypalConnected: true,
    paypalEmail: 'billing@acmecorp.sandbox.paypal.com',
    walletBalance: 2500.0,
    policyText: 'Max $250 per purchase and $2000 a month. Only electronics and software. Ask me above $100. No transfers to unauthorized accounts.',
  },
  {
    id: 'usr_redteam',
    name: 'SecOps Adversary Lab',
    email: 'auditor@secops.example',
    role: 'Security Auditor',
    avatar: 'SO',
    paypalConnected: false,
    paypalEmail: 'auditor@secops.sandbox.paypal.com',
    walletBalance: 100.0,
    policyText: 'Max $25 per purchase and $100 a month. Only electronics. Strict zero transfers under any circumstances.',
  },
];

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, combined) {
  const [salt, originalHash] = combined.split(':');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(originalHash, 'hex'));
}

export class AuthStore {
  constructor() {
    this.users = new Map();
    this.sessions = new Map();
    this.seedDemoUsers();
  }

  seedDemoUsers() {
    for (const p of DEMO_PROFILES) {
      this.users.set(p.email.toLowerCase(), {
        ...p,
        passwordHash: hashPassword('password123'),
        createdAt: new Date().toISOString(),
      });
    }
  }

  getProfiles() {
    return DEMO_PROFILES.map(({ id, name, email, role, avatar, paypalConnected, paypalEmail, walletBalance, policyText }) => ({
      id,
      name,
      email,
      role,
      avatar,
      paypalConnected,
      paypalEmail,
      walletBalance,
      policyText,
    }));
  }

  signup({ name, email, password, role = 'Personal Shopper' }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) throw new Error('Valid email required');
    if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');
    if (this.users.has(cleanEmail)) throw new Error('Account with this email already exists');

    const cleanName = String(name || '').trim() || cleanEmail.split('@')[0];
    const initials = cleanName
      .split(' ')
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || 'U';

    const user = {
      id: `usr_${crypto.randomBytes(5).toString('hex')}`,
      name: cleanName,
      email: cleanEmail,
      role,
      avatar: initials,
      paypalConnected: true,
      paypalEmail: `${cleanEmail.split('@')[0]}.sandbox@paypal.com`,
      walletBalance: 200.0,
      policyText: 'Max $50 per purchase and $200 a month. Only electronics and books. Ask me before anything over $30. No transfers to people.',
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };

    this.users.set(cleanEmail, user);
    return this.createSession(user.id);
  }

  login({ email, password }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const user = this.users.get(cleanEmail);
    if (!user) throw new Error('Invalid email or password');
    if (!verifyPassword(password, user.passwordHash)) throw new Error('Invalid email or password');
    return this.createSession(user.id);
  }

  loginAsDemo(profileId) {
    const user = [...this.users.values()].find((u) => u.id === profileId);
    if (!user) throw new Error('Demo profile not found');
    return this.createSession(user.id);
  }

  createSession(userId) {
    const user = [...this.users.values()].find((u) => u.id === userId);
    if (!user) throw new Error('User not found');

    const token = `lsh_${crypto.randomBytes(24).toString('hex')}`;
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

    this.sessions.set(token, {
      userId: user.id,
      expiresAt,
    });

    return {
      token,
      user: this.sanitizeUser(user),
    };
  }

  verifySession(token) {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.now() > s.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    const user = [...this.users.values()].find((u) => u.id === s.userId);
    return user ? this.sanitizeUser(user) : null;
  }

  logout(token) {
    if (token) this.sessions.delete(token);
    return { ok: true };
  }

  sanitizeUser(user) {
    const { passwordHash, ...safe } = user;
    return safe;
  }
}

export const authStore = new AuthStore();
