require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const { google } = require('googleapis');

const app = express();

// ====================
// Database
// ====================
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'Aneesa197381@',
  database: process.env.DB_NAME || 'voiceapp',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

pool.on('connect', () => console.log('✅ Connected to DB'));
pool.on('error', (err) => console.error('DB Error:', err));




// ====================
// Middleware
// ====================
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN,
  methods: ["GET", "POST"],
  credentials: true
}));
app.use(bodyParser.json());
app.use(express.static(__dirname));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ====================
// Multer Storage
// ====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  }
});
const uploadRecording = multer({ storage });

// ====================
// Google Drive Setup
// ====================
// ====================
// Google Drive Service account Setup
const KEYFILE = path.join(__dirname, process.env.GOOGLE_KEYFILE); // service-account.json
const SCOPES = ['https://www.googleapis.com/auth/drive'];

const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILE,
  scopes: SCOPES
});

const drive = google.drive({ version: 'v3', auth });



// ====================
// Auth Routes
// ====================
app.post('/auth/signup', async (req, res) => {
  try {
    const { username, password, age, gender, city, language } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username & password required' });

    const userCheck = await pool.query('SELECT * FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (userCheck.rowCount > 0) return res.status(400).json({ message: 'Username already exists' });

    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password, age, gender, city, language) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username`,
      [username, hashed, age, gender, city, language]
    );

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ message: 'Signup failed' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username & password required' });

    const userRes = await pool.query('SELECT * FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (userRes.rowCount === 0) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const user = userRes.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    res.json({ success: true, user });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Check if a folder exists for the user, else create it
// Helper: sanitize folder name for Drive
function sanitizeFolderName(name) {
  return name.replace(/[^a-zA-Z0-9-_ ]/g, '_'); // replace special chars
}

// Helper: get or create a Drive folder for the user
async function getOrCreateUserFolder(username) {
    let parentFolderId = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID; // main parent folder

    if (!parentFolderId) {
        throw new Error("Missing GOOGLE_DRIVE_PARENT_FOLDER_ID in .env");
    }

    // If someone accidentally put a full Drive URL, extract the folder ID
    if (parentFolderId.includes('drive.google.com')) {
        const match = parentFolderId.match(/[-\w]{25,}/);
        if (match) parentFolderId = match[0];
        else throw new Error("Invalid GOOGLE_DRIVE_PARENT_FOLDER_ID, could not extract ID");
    }

    const folderName = username; // subfolder per user

    // 1️⃣ Check if folder exists
    const res = await drive.files.list({
        q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentFolderId}' in parents and trashed=false`,
        fields: 'files(id, name)'
    });

    if (res.data.files.length > 0) {
        return res.data.files[0].id; // folder exists
    }

    // 2️⃣ Create folder under parent
    const folderMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId]
    };

    const folder = await drive.files.create({
        requestBody: folderMetadata,
        fields: 'id'
    });

    return folder.data.id;
}




// ------------------ Upload ------------------
// ====================
// Upload Route (with Folder & Access Code)
// ====================
// ====================
// Upload Route (Service Account ready)
// ====================
app.post('/upload', uploadRecording.single('audio'), async (req, res) => {
  try {
    const { userId, username, folder, accessCode } = req.body;
    if (!userId || !req.file || !username) {
      return res.status(400).json({ error: "Missing data" });
    }

    const localPath = req.file.path;
    const { originalname, mimetype, size } = req.file;

    // Get or create user folder
    const userFolderId = await getOrCreateUserFolder(username);

    // Upload to Drive
    const media = { mimeType: mimetype, body: fs.createReadStream(localPath) };
    const resource = { name: originalname, parents: [userFolderId] };
    const gfile = await drive.files.create({ requestBody: resource, media, fields: 'id' });

    const driveFileId = gfile.data.id;

    // Make public (optional)
    await drive.permissions.create({
      fileId: driveFileId,
      requestBody: { role: 'reader', type: 'anyone' }
    });

    // Save metadata to DB
    const publicUrl = `https://drive.google.com/uc?id=${driveFileId}&export=download`;
    const query = `
      INSERT INTO files (owner_id, file_id, file_name, folder_name, access_code, mime_type, size_bytes, filepath, drive_url, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING id
    `;
    const { rows } = await pool.query(query, [
      userId, driveFileId, originalname, username, accessCode || null,
      mimetype, size, localPath, publicUrl
    ]);

    res.json({ success: true, id: rows[0].id, driveUrl: publicUrl });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================
// UploadToDrive Route (Service Account ready)
// ====================
app.post('/uploadToDrive', async (req, res) => {
  try {
    const { filename, data, userId, folder } = req.body;
    if (!filename || !data || !userId || !folder) return res.status(400).json({ error: "Missing data" });

    // Decode base64 audio
    const buffer = Buffer.from(data.split(",")[1], 'base64');
    const tmpPath = path.join(__dirname, "uploads", filename);
    fs.writeFileSync(tmpPath, buffer);

    // Upload to Drive
    const userFolderId = await getOrCreateUserFolder(folder);
    const gfile = await drive.files.create({
      requestBody: { name: filename, parents: [userFolderId] },
      media: { mimeType: "audio/mp3", body: fs.createReadStream(tmpPath) },
      fields: "id"
    });

    const driveFileId = gfile.data.id;

    // Make public (optional)
    await drive.permissions.create({
      fileId: driveFileId,
      requestBody: { role: 'reader', type: 'anyone' }
    });

    const publicUrl = `https://drive.google.com/uc?id=${driveFileId}&export=download`;

    // Save metadata to DB
    const query = `
      INSERT INTO files (owner_id, file_id, file_name, folder_name, drive_url, created_at) 
      VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id
    `;
    const { rows } = await pool.query(query, [userId, driveFileId, filename, folder, publicUrl]);

    // Remove temp file
    fs.unlinkSync(tmpPath);

    res.json({ success: true, driveUrl: publicUrl, id: rows[0].id });
  } catch (err) {
    console.error('UploadToDrive error:', err);
    res.status(500).json({ error: err.message });
  }
});



//uploadToDrive

app.post('/uploadAllToDrive', async (req, res) => {
  try {
    const { recordings, userId, folder } = req.body;
    if (!Array.isArray(recordings) || recordings.length === 0 || !userId || !folder) 
      return res.status(400).json({ error: "Missing data" });

    const uploadedFiles = [];
    const userFolderId = await getOrCreateUserFolder(folder);

    for (let r of recordings) {
      const buffer = Buffer.from(r.data.split(",")[1], 'base64');
      const tmpPath = path.join(__dirname, "uploads", r.filename);
      fs.writeFileSync(tmpPath, buffer);

      const gfile = await drive.files.create({
        requestBody: { name: r.filename, parents: [userFolderId] },
        media: { mimeType: "audio/mp3", body: fs.createReadStream(tmpPath) },
        fields: "id"
      });

      await drive.permissions.create({ 
        fileId: gfile.data.id, 
        requestBody: { role: 'reader', type: 'anyone' } 
      });

      const publicUrl = `https://drive.google.com/uc?id=${gfile.data.id}&export=download`;
      await pool.query(`
        INSERT INTO files (owner_id, file_id, file_name, folder_name, drive_url, created_at) 
        VALUES ($1,$2,$3,$4,$5,NOW())
      `, [userId, gfile.data.id, r.filename, folder, publicUrl]);

      fs.unlinkSync(tmpPath);
      uploadedFiles.push({ filename: r.filename, driveUrl: publicUrl });
    }

    res.json({ success: true, uploaded: uploadedFiles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});



// ====================
// Fetch Recordings
// ====================
app.get('/recordings/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT id, file_name, folder_name, drive_url, created_at 
       FROM files WHERE owner_id=$1 ORDER BY created_at DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch recordings' });
  }
});

// ====================
// Public Recordings Routes
// ====================
app.post("/public/save", async (req, res) => {
  try {
    const { code, recordings, owner } = req.body;

    // Input validation
    if (!code || !owner || !Array.isArray(recordings) || recordings.length === 0) {
      return res.status(400).json({ message: "Missing data or no recordings provided" });
    }

    // Prepare insert promises
    const insertPromises = recordings.map(async (r) => {
      try {
        await pool.query(
          'INSERT INTO public_recordings (code, owner, recording) VALUES ($1, $2, $3)',
          [code, owner, JSON.stringify({ filename: r.filename, driveUrl: r.driveUrl })]
        );
        return { filename: r.filename, status: "saved" };
      } catch (err) {
        console.error(`Failed to save recording ${r.filename}:`, err);
        return { filename: r.filename, status: "failed", error: err.message };
      }
    });

    // Wait for all inserts
    const results = await Promise.all(insertPromises);

    // Separate successes and failures
    const saved = results.filter(r => r.status === "saved");
    const failed = results.filter(r => r.status === "failed");

    res.json({
      message: "Public recordings processed",
      code,
      saved,
      failed
    });
  } catch (err) {
    console.error('Public save route error:', err);
    res.status(500).json({ message: "Server error while saving recordings" });
  }
});


app.get("/public/:code", async (req, res) => {
  try {
    const code = req.params.code;

    const { rows } = await pool.query(
      'SELECT recording, owner, created_at FROM public_recordings WHERE code=$1 ORDER BY created_at DESC',
      [code]
    );

    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    await pool.query('DELETE FROM public_recordings WHERE created_at < $1', [twelveHoursAgo]);

    const formatted = rows.map(r => ({
    owner: r.owner,
    created_at: r.created_at,
    recording: typeof r.recording === "string" ? JSON.parse(r.recording) : r.recording
    }));


    res.json({ recordings: formatted });
  } catch (err) {
    console.error('Public fetch error:', err);
    res.status(500).json({ message: 'Failed to fetch public recordings' });
  }
});


// ====================
// Auto Delete Old Files
// ====================
setInterval(async () => {
  try {
    const result = await pool.query(`
      DELETE FROM files  
      WHERE created_at < NOW() - INTERVAL '12 hours' 
      RETURNING filepath
    `);
    result.rows.forEach(row => {
      const filePath = path.join(__dirname, row.filepath);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
    if (result.rowCount > 0)
      console.log(`🧹 Deleted ${result.rowCount} expired recordings`);
  } catch (err) {
    console.error('Cleanup failed:', err);
  }
}, 12 * 60 * 60 * 1000);

async function cleanupOldPublicRecordings() {
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
  await pool.query('DELETE FROM public_recordings WHERE created_at < $1', [twelveHoursAgo]);
}
cleanupOldPublicRecordings();


// ====================
// Frontend
// ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
