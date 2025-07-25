require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Create tables if not exists
const initializeDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        subject VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create payment registrations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_registrations (
        id SERIAL PRIMARY KEY,
        client_name VARCHAR(100) NOT NULL,
        project_name VARCHAR(100) NOT NULL,
        client_id VARCHAR(50) NOT NULL,
        amount NUMERIC(10, 2) NOT NULL,
        due_date DATE NOT NULL,
        receipt_url TEXT NOT NULL,
        reference_id VARCHAR(50) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add to initializeDb function
  await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_links (
        id SERIAL PRIMARY KEY,
        token VARCHAR(100) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Insert the fixed token if not exists
     await pool.query(`
      INSERT INTO payment_links (token)
      VALUES ('4vXcZpLmKjQ8aTyNfRbEoWg7HdUs29qT')
      ON CONFLICT (token) DO NOTHING
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        company VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_links (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        token VARCHAR(100) UNIQUE NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL
      )
    `);

    console.log('Database initialized');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
};

initializeDb();

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Endpoint to check link status
app.get('/api/payment-link/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM payment_links WHERE token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment link not found'
      });
    }

    // Always return active: true
    res.status(200).json({
      success: true,
      active: true
    });
  } catch (error) {
    console.error('Error fetching link status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch link status'
    });
  }
});


// Endpoint to toggle link status
app.put('/api/admin/payment-link/:token', async (req, res) => {
  const { token } = req.params;
  const { active } = req.body;

  try {
    const result = await pool.query(
      `UPDATE payment_links 
       SET active = $1
       WHERE token = $2
       RETURNING *`,
      [active, token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment link not found'
      });
    }

    res.status(200).json({
      success: true,
      message: `Link ${active ? 'activated' : 'deactivated'}`,
      paymentLink: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating link status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update link status'
    });
  }
});

// Contact form submission
app.post('/api/contact/submit', async (req, res) => {
  const { name, email, phone, subject, message } = req.body;

  const errors = {};

  if (!name || name.trim().length < 3) errors.name = 'Name must be at least 3 characters';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Valid email is required';
  if (!phone || !/^[6-9]\d{9}$/.test(phone)) errors.phone = 'Valid 10-digit phone number starting with 6-9 is required';
  if (!subject) errors.subject = 'Please select a service';
  if (!message || message.trim().length < 10) errors.message = 'Message must be at least 10 characters';

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ errors });
  }

  try {
    const result = await pool.query(
      `INSERT INTO contacts (name, email, phone, subject, message) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [name, email, phone, subject, message]
    );

    res.status(201).json({
      success: true,
      message: 'Form submitted successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit form',
      error: error.message
    });
  }
});

// Get all contact submissions
app.get('/api/contacts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM contacts 
      ORDER BY created_at DESC
    `);

    // Format dates for better readability
    const contacts = result.rows.map(contact => ({
      ...contact,
      created_at: new Date(contact.created_at).toLocaleString()
    }));

    res.status(200).json(contacts);
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch contacts',
      error: error.message
    });
  }
});

// Payment registration submission
app.post('/api/payment/submit', async (req, res) => {
  const { clientName, projectName, clientId, amount, dueDate, receiptUrl } = req.body;

  // Generate reference ID (format: PAY-YYYY-RANDOM6)
  const year = new Date().getFullYear();
  const randomString = Math.random().toString(36).substr(2, 6).toUpperCase();
  const referenceId = `PAY-${year}-${randomString}`;

  try {
    const result = await pool.query(
      `INSERT INTO payment_registrations 
        (client_name, project_name, client_id, amount, due_date, receipt_url, reference_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING *`,
      [clientName, projectName, clientId, amount, dueDate, receiptUrl, referenceId]
    );

    res.status(201).json({
      success: true,
      message: 'Payment registration submitted successfully',
      referenceId,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit payment registration',
      error: error.message
    });
  }
});

// ADMIN ROUTES ------------------------------------------------------------

// Get all payment registrations (for admin panel)
app.get('/api/admin/payments', async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT *, COUNT(*) OVER() AS total_count 
      FROM payment_registrations
    `;

    let params = [];
    let conditions = [];

    if (status && status !== 'all') {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += `
      ORDER BY created_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    params.push(limit, offset);

    const result = await pool.query(query, params);

    const total = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      success: true,
      payments: result.rows.map(row => {
        const { total_count, ...payment } = row;
        return payment;
      }),
      pagination: {
        total,
        totalPages,
        currentPage: Number(page),
        limit: Number(limit)
      }
    });
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment registrations',
      error: error.message
    });
  }
});

// Get single payment registration by ID
app.get('/api/admin/payments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM payment_registrations WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment registration not found'
      });
    }

    res.status(200).json({
      success: true,
      payment: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching payment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment registration',
      error: error.message
    });
  }
});

// Update payment status (e.g., verified/rejected)
app.put('/api/admin/payments/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'verified', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status value'
      });
    }

    const result = await pool.query(
      `UPDATE payment_registrations 
       SET status = $1
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment registration not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Payment status updated',
      payment: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating payment status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update payment status',
      error: error.message
    });
  }
});

// Search payment registrations
app.get('/api/admin/payments/search', async (req, res) => {
  try {
    const { query } = req.query;

    if (!query || query.trim().length < 3) {
      return res.status(400).json({
        success: false,
        message: 'Search query must be at least 3 characters'
      });
    }

    const searchTerm = `%${query}%`;
    const result = await pool.query(
      `SELECT * FROM payment_registrations
       WHERE client_name ILIKE $1
          OR project_name ILIKE $1
          OR client_id ILIKE $1
          OR reference_id ILIKE $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [searchTerm]
    );

    res.status(200).json({
      success: true,
      payments: result.rows
    });
  } catch (error) {
    console.error('Error searching payments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search payment registrations',
      error: error.message
    });
  }
});

// Endpoint to get payment link by token (for admin panel)
app.get('/api/admin/payment-link/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM payment_links WHERE token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment link not found'
      });
    }

    res.status(200).json({
      success: true,
      paymentLink: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching payment link:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment link'
    });
  }
});

// New endpoints for client management
app.post('/api/admin/clients', async (req, res) => {
  const { name, email, phone, company } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO clients (name, email, phone, company)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, email, phone, company]
    );

    res.status(201).json({
      success: true,
      client: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating client:', error);
    res.status(500).json({ success: false, message: 'Failed to create client' });
  }
});

app.get('/api/admin/clients', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, 
             cl.token AS active_token,
             cl.expires_at AS token_expiry,
             cl.active AS token_active
      FROM clients c
      LEFT JOIN client_links cl ON c.id = cl.client_id 
        AND cl.expires_at > NOW()
        AND cl.active = true
      ORDER BY c.created_at DESC
    `);

    res.status(200).json({ success: true, clients: result.rows });
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch clients' });
  }
});

app.post('/api/admin/client-links', async (req, res) => {
  const { clientId } = req.body;

  // Generate unique token
  const token = crypto.randomBytes(32).toString('hex');

  // Set expiration to 1 day from now
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 1);

  try {
    // Create new link - ALWAYS ACTIVE
    const result = await pool.query(
      `INSERT INTO client_links (client_id, token, expires_at)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [clientId, token, expiresAt]
    );

    res.status(201).json({
      success: true,
      link: `https://www.zorvixetechnologies.com/payment/${token}`,
      token,
      expiresAt
    });
  } catch (error) {
    console.error('Error generating link:', error);
    res.status(500).json({ success: false, message: 'Failed to generate link' });
  }
});


app.get('/api/client-details/:token', async (req, res) => {
  const { token } = req.params;

  try {
    // Get link details
    const linkResult = await pool.query(
      `SELECT * FROM client_links 
       WHERE token = $1 
         AND active = true 
         AND expires_at > NOW()`,
      [token]
    );

    if (linkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Link not found or expired'
      });
    }

    const link = linkResult.rows[0];

    // Get client details
    const clientResult = await pool.query(
      `SELECT * FROM clients WHERE id = $1`,
      [link.client_id]
    );

    if (clientResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    const client = clientResult.rows[0];
    
    // Get payment details (if any)
    const paymentResult = await pool.query(
      `SELECT * FROM payment_registrations 
       WHERE client_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [client.id]
    );
    
    const paymentDetails = paymentResult.rows[0] || {
      amount: 5000, // Default amount
      due_date: new Date(Date.now() + 7*24*60*60*1000) // Default due in 7 days
    };

    res.status(200).json({
      success: true,
      client: {
        ...client,
        clientName: client.name,
        clientId: client.id,
        projectName: paymentDetails.project_name || "New Project",
        amount: paymentDetails.amount,
        dueDate: paymentDetails.due_date
      }
    });
  } catch (error) {
    console.error('Error fetching client details:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch client details'
    });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});