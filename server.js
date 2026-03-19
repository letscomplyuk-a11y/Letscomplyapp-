import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import bcryptjs from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import { requestLoggingMiddleware, errorLoggingMiddleware, appLogger, getHealthStatus } from './monitoring.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_your_key';
const stripe = new Stripe(STRIPE_SECRET_KEY);

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'your-email@gmail.com',
    pass: process.env.EMAIL_PASSWORD || 'your-app-password'
  }
});

// Setup multer for file uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
    }
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(requestLoggingMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

appLogger.info('LetsComply Server Starting', { port: PORT, timestamp: new Date().toISOString() });

// Initialize SQLite database
const db = new sqlite3.Database(path.join(__dirname, 'letscomply.db'), (err) => {
  if (err) console.error('Database error:', err);
  else console.log('Connected to SQLite database');
});

// Initialize database tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      tier TEXT DEFAULT 'Starter',
      trial_start_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      trial_end_date DATETIME,
      payment_status TEXT DEFAULT 'pending',
      stripe_customer_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      jurisdiction TEXT DEFAULT 'UK',
      photo_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      certificate_type TEXT NOT NULL,
      issue_date DATE,
      expiry_date DATE,
      file_path TEXT,
      status TEXT DEFAULT 'valid',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (property_id) REFERENCES properties(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      stripe_payment_intent_id TEXT,
      amount INTEGER,
      currency TEXT DEFAULT 'GBP',
      status TEXT DEFAULT 'pending',
      payment_date DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Add missing columns if they don't exist (migration for existing databases)
  db.run(`ALTER TABLE properties ADD COLUMN photo_path TEXT`, (err) => {
    if (err) {
      if (!err.message.includes('duplicate column')) {
        console.log('Note: photo_path column already exists or migration not needed');
      }
    } else {
      console.log('Successfully added photo_path column to properties table');
    }
  });

  // Add trial_start_date column if it doesn't exist
  db.run(`ALTER TABLE users ADD COLUMN trial_start_date DATETIME DEFAULT CURRENT_TIMESTAMP`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.log('Note: trial_start_date column already exists or migration not needed');
    }
  });

  // Add trial_end_date column if it doesn't exist
  db.run(`ALTER TABLE users ADD COLUMN trial_end_date DATETIME`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.log('Note: trial_end_date column already exists or migration not needed');
    }
  });

  // Add payment_status column if it doesn't exist
  db.run(`ALTER TABLE users ADD COLUMN payment_status TEXT DEFAULT 'pending'`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.log('Note: payment_status column already exists or migration not needed');
    }
  });

  // Add stripe_customer_id column if it doesn't exist
  db.run(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.log('Note: stripe_customer_id column already exists or migration not needed');
    }
  });
});

// Middleware to verify JWT
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid token' });
    req.userId = decoded.id;
    next();
  });
}

// Routes

// Serve landing page on root (index.html is now the landing page)
// app.get('/', handled by static middleware)

// Serve app dashboard
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app-dashboard.html'));
});

// Serve app dashboard when accessing /dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app-dashboard.html'));
});

// Sign Up with 14-day trial
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name, tier } = req.body;
  const selectedTier = tier || 'Starter'; // Starter, Professional, or Agency

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const hashedPassword = bcryptjs.hashSync(password, 10);
    
    // Calculate trial end date (14 days from now)
    const trialStartDate = new Date();
    const trialEndDate = new Date(trialStartDate.getTime() + 14 * 24 * 60 * 60 * 1000);

    // Create Stripe customer
    const stripeCustomer = await stripe.customers.create({
      email: email,
      name: name
    });

    db.run(
      'INSERT INTO users (email, password, name, tier, trial_end_date, stripe_customer_id) VALUES (?, ?, ?, ?, ?, ?)',
      [email, hashedPassword, name, selectedTier, trialEndDate.toISOString(), stripeCustomer.id],
      async function (err) {
        if (err) {
          console.error('Database insert error:', err);
          return res.status(400).json({ error: 'Email already exists' });
        }

        // Send confirmation email
        const mailOptions = {
          from: process.env.EMAIL_USER || 'noreply@letscomplly.uk',
          to: email,
          subject: 'Welcome to LetsComply - Your 14-Day Free Trial',
          html: `
            <h2>Welcome to LetsComply!</h2>
            <p>Hi ${name},</p>
            <p>Thank you for choosing LetsComply. Your ${selectedTier} plan is now active with a 14-day free trial.</p>
            <p><strong>Your payment will be taken in fourteen days unless cancelled.</strong></p>
            <p>Trial ends on: ${trialEndDate.toLocaleDateString()}</p>
            <p>Plan: ${selectedTier}</p>
            <p>You can log in and start managing your properties immediately.</p>
            <p>Best regards,<br/>The LetsComply Team</p>
          `
        };

        transporter.sendMail(mailOptions, (err, info) => {
          if (err) console.log('Email error:', err);
          else console.log('Confirmation email sent:', info.response);
        });

        const token = jwt.sign({ id: this.lastID }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ 
          token, 
          user: { 
            id: this.lastID, 
            email, 
            name, 
            tier: selectedTier,
            trial_end_date: trialEndDate.toISOString()
          } 
        });
      }
    );
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }

  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (err || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!bcryptjs.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, tier: user.tier } });
  });
});

// Get user profile with trial status
app.get('/api/user/profile', verifyToken, (req, res) => {
  db.get('SELECT id, email, name, tier, trial_end_date, payment_status FROM users WHERE id = ?', [req.userId], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Check if trial has expired
    const now = new Date();
    const trialEndDate = new Date(user.trial_end_date);
    const isTrialExpired = now > trialEndDate;
    
    res.json({
      ...user,
      isTrialExpired,
      daysRemaining: Math.ceil((trialEndDate - now) / (1000 * 60 * 60 * 24))
    });
  });
});

// Get all properties for user
app.get('/api/properties', verifyToken, (req, res) => {
  db.all('SELECT * FROM properties WHERE user_id = ?', [req.userId], (err, properties) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(properties || []);
  });
});

// Add new property
app.post('/api/properties', verifyToken, (req, res) => {
  const { name, address, jurisdiction } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Property name is required' });
  }

  // Check tier limits
  db.get('SELECT tier FROM users WHERE id = ?', [req.userId], (err, user) => {
    if (err || !user) {
      return res.status(500).json({ error: 'User not found' });
    }

    // Tier-based property limits
    db.get('SELECT COUNT(*) as count FROM properties WHERE user_id = ?', [req.userId], (err, result) => {
      if ((user.tier === 'Starter' || user.tier === 'Professional') && result.count >= 25) {
        return res.status(403).json({ error: 'Your plan limited to 25 properties. Upgrade to Agency plan (26+ properties) for unlimited properties.' });
      } else if (user.tier === 'Agency' && result.count >= 999) {
        return res.status(403).json({ error: 'Agency tier limited to 999 properties.' });
      }
      createProperty();
    });
  });

  function createProperty() {
    db.run(
      'INSERT INTO properties (user_id, name, address, jurisdiction) VALUES (?, ?, ?, ?)',
      [req.userId, name, address, jurisdiction || 'UK'],
      function (err) {
        if (err) {
          return res.status(500).json({ error: 'Failed to create property' });
        }
        res.json({ id: this.lastID, user_id: req.userId, name, address, jurisdiction: jurisdiction || 'UK' });
      }
    );
  }
});

// Upload property photo
app.post('/api/properties/:propertyId/photo', verifyToken, upload.single('photo'), (req, res) => {
  const { propertyId } = req.params;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Verify property belongs to user
  db.get(
    'SELECT id FROM properties WHERE id = ? AND user_id = ?',
    [propertyId, req.userId],
    (err, property) => {
      if (err || !property) {
        // Delete uploaded file if property not found
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Property not found' });
      }

      const photoPath = `/uploads/${req.file.filename}`;

      // Update property with photo path
      db.run(
        'UPDATE properties SET photo_path = ? WHERE id = ?',
        [photoPath, propertyId],
        (err) => {
          if (err) {
            fs.unlink(req.file.path, () => {});
            return res.status(500).json({ error: 'Failed to save photo' });
          }
          res.json({ success: true, photoPath });
        }
      );
    }
  );
});

// Get certificates for property
app.get('/api/properties/:propertyId/certificates', verifyToken, (req, res) => {
  const { propertyId } = req.params;

  db.all(
    'SELECT c.* FROM certificates c JOIN properties p ON c.property_id = p.id WHERE p.user_id = ? AND c.property_id = ?',
    [req.userId, propertyId],
    (err, certificates) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(certificates || []);
    }
  );
});

// Add certificate with tier-based limits
app.post('/api/properties/:propertyId/certificates', verifyToken, (req, res) => {
  const { propertyId } = req.params;
  const { certificate_type, issue_date, expiry_date } = req.body;

  if (!certificate_type || !expiry_date) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Check tier limits
  db.get('SELECT tier FROM users WHERE id = ?', [req.userId], (err, user) => {
    if (err || !user) {
      return res.status(500).json({ error: 'User not found' });
    }

    // Agency tier has unlimited certificates, others have no limit per property
    if (user.tier === 'Starter' || user.tier === 'Professional' || user.tier === 'Agency') {
      createCertificate();
    }
  });

  function createCertificate() {
    db.run(
      'INSERT INTO certificates (property_id, certificate_type, issue_date, expiry_date, status) VALUES (?, ?, ?, ?, ?)',
      [propertyId, certificate_type, issue_date, expiry_date, 'valid'],
      function (err) {
        if (err) {
          return res.status(500).json({ error: 'Failed to add certificate' });
        }
        res.json({ id: this.lastID, property_id: propertyId, certificate_type, issue_date, expiry_date, status: 'valid' });
      }
    );
  }
});

// Get compliance score for property
app.get('/api/properties/:propertyId/compliance-score', verifyToken, (req, res) => {
  const { propertyId } = req.params;

  db.all(
    'SELECT * FROM certificates WHERE property_id = ?',
    [propertyId],
    (err, certificates) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (!certificates || certificates.length === 0) {
        return res.json({ score: 0, total: 0, valid: 0, expiring: 0, expired: 0 });
      }

      const today = new Date();
      const thirtyDaysFromNow = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

      let valid = 0;
      let expiring = 0;
      let expired = 0;

      certificates.forEach((cert) => {
        const expiryDate = new Date(cert.expiry_date);
        if (expiryDate < today) {
          expired++;
        } else if (expiryDate <= thirtyDaysFromNow) {
          expiring++;
        } else {
          valid++;
        }
      });

      const score = Math.round((valid / certificates.length) * 100);
      res.json({ score, total: certificates.length, valid, expiring, expired });
    }
  );
});

// Create payment intent for Stripe
app.post('/api/payments/create-intent', verifyToken, async (req, res) => {
  try {
    db.get('SELECT tier, stripe_customer_id FROM users WHERE id = ?', [req.userId], async (err, user) => {
      if (err || !user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Pricing in pence (GBP)
      const prices = {
        'Starter': 999,    // £9.99
        'Professional': 1999, // £19.99
        'Agency': 4999     // £49.99
      };

      const amount = prices[user.tier] || 999;

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: 'gbp',
        customer: user.stripe_customer_id,
        metadata: {
          userId: req.userId,
          tier: user.tier
        }
      });

      res.json({ clientSecret: paymentIntent.client_secret });
    });
  } catch (error) {
    console.error('Payment intent error:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

// Confirm payment
app.post('/api/payments/confirm', verifyToken, async (req, res) => {
  const { paymentIntentId } = req.body;

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status === 'succeeded') {
      db.run(
        'UPDATE users SET payment_status = ? WHERE id = ?',
        ['paid', req.userId],
        (err) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to update payment status' });
          }

          // Send payment confirmation email
          db.get('SELECT email, name FROM users WHERE id = ?', [req.userId], (err, user) => {
            if (user) {
              const mailOptions = {
                from: process.env.EMAIL_USER || 'noreply@letscomplly.uk',
                to: user.email,
                subject: 'Payment Received - LetsComply',
                html: `
                  <h2>Payment Confirmed</h2>
                  <p>Hi ${user.name},</p>
                  <p>Thank you for your payment. Your LetsComply subscription is now active.</p>
                  <p>You can now access all features of your plan.</p>
                  <p>Best regards,<br/>The LetsComply Team</p>
                `
              };

              transporter.sendMail(mailOptions, (err, info) => {
                if (err) console.log('Email error:', err);
              });
            }
          });

          res.json({ success: true, message: 'Payment confirmed' });
        }
      );
    } else {
      res.status(400).json({ error: 'Payment not completed' });
    }
  } catch (error) {
    console.error('Payment confirmation error:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json(getHealthStatus());
});

// Metrics endpoint
app.get('/metrics', (req, res) => {
  const metrics = getHealthStatus();
  res.json(metrics);
});

// Chatbot endpoint
app.post('/api/chatbot/ask', verifyToken, (req, res) => {
  const { question } = req.body;
  
  if (!question || question.trim().length === 0) {
    return res.status(400).json({ error: 'Question is required' });
  }

  // Holiday Let Compliance Knowledge Base
  const knowledgeBase = {
    'regulations': 'UK holiday let regulations require compliance with local authority planning permissions, building regulations, and fire safety standards. You must register with your local council.',
    'planning permission': 'You may need planning permission to use your property as a holiday let. Contact your local planning authority for specific guidance.',
    'fire safety': 'Fire safety is critical. You must have working smoke alarms on every level, fire extinguishers, emergency lighting, and clear escape routes.',
    'building regulations': 'Holiday lets must comply with building regulations including structural integrity, electrical safety, gas safety, and accessibility.',
    'licensing': 'Some areas require holiday let licenses. Check with your local authority for requirements.',
    'registration': 'You must register your holiday let with your local council.',
    'insurance': 'Standard home insurance does not cover holiday lets. You need specialist holiday let insurance.',
    'liability': 'You must have public liability insurance. Minimum coverage is usually 1-2 million pounds.',
    'safety equipment': 'Install smoke alarms, carbon monoxide detectors, fire extinguishers, and first aid kits.',
    'electrical safety': 'Have a qualified electrician perform an EICR every 5 years.',
    'gas safety': 'If you have gas appliances, you must have an annual gas safety check by a registered engineer.',
    'guests': 'Maintain detailed records of all guests including names and dates of stay.',
    'terms and conditions': 'Create clear terms covering cancellation, house rules, and liability.',
    'maintenance': 'Perform regular maintenance and keep detailed records.',
    'cleaning': 'Thoroughly clean between guests and maintain high hygiene standards.',
    'taxes': 'You must declare holiday let income to HMRC. Keep detailed records.',
    'expenses': 'Deductible expenses include mortgage interest, utilities, insurance, and maintenance.',
    'compliance score': 'Your compliance score reflects how well you meet regulations. Improve it by addressing safety and documentation gaps.'
  };

  // Convert question to lowercase for matching
  const lowerQuestion = question.toLowerCase();
  
  // Find matching answer
  let answer = 'I am not sure about that. Could you ask about holiday let regulations, fire safety, insurance, guest management, maintenance, or taxes?';
  
  for (const [key, value] of Object.entries(knowledgeBase)) {
    if (lowerQuestion.includes(key)) {
      answer = value;
      break;
    }
  }
  
  res.json({ answer });
});

// Error handling middleware
app.use(errorLoggingMiddleware);

// Start server
app.listen(PORT, () => {
  console.log(`LetsComply API running on http://localhost:${PORT}`);
  appLogger.info('Server started successfully', { port: PORT });
});
