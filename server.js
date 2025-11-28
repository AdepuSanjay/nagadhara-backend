// server.js
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ----------------- Cloudinary (inlined as requested) -----------------
// WARNING: for production move these to environment variables.
cloudinary.config({
  cloud_name: "dppiuypop", // Replace with your Cloudinary cloud name
  api_key: "412712715735329", // Replace with your Cloudinary API key
  api_secret: "m04IUY0-awwtr4YoS-1xvxOOIzU", // Replace with your Cloudinary API secret
});

// Helper: upload buffer to Cloudinary, returns upload result
function uploadBufferToCloudinary(buffer, folder = 'security_visitors') {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

// ----------------- MongoDB (direct string as requested) -----------------
const MONGO_URL = 'mongodb+srv://abc:1234@cluster0.nnjwt12.mongodb.net/security';
mongoose.connect(MONGO_URL)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// ----------------- Schemas & Models -----------------
const { Schema } = mongoose;

// single user model for resident | security | admin
const UserSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }, // plain text (as requested)
  role: { type: String, enum: ['resident','security','admin'], default: 'resident' },
  phone: { type: String },
  roomId: { type: String }, // for residents
  expoPushToken: { type: String },
}, { timestamps: true });

const RoomSchema = new Schema({
  roomLabel: { type: String, required: true, unique: true },
  occupant: { type: String },
}, { timestamps: true });

const VisitSchema = new Schema({
  roomId: { type: String, required: true },
  roomLabel: { type: String },
  visitorName: { type: String, required: true },
  purpose: { type: String },
  phone: { type: String },
  photoPath: { type: String }, // will store Cloudinary secure_url
  status: { type: String, default: 'pending' }, // pending, approved, denied
  notified: { type: Boolean, default: false },
  residentUserId: { type: mongoose.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);
const Room = mongoose.model('Room', RoomSchema);
const Visit = mongoose.model('Visit', VisitSchema);

// ----------------- multer (memory storage for direct Cloudinary upload) -----------------
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ----------------- Expo Push helper -----------------
async function sendExpoPush(expoPushToken, title, body, data = {}) {
  try {
    const messages = [{
      to: expoPushToken,
      sound: 'default',
      title,
      body,
      data
    }];
    // Expo push API accepts an array of messages
    const resp = await axios.post('https://exp.host/--/api/v2/push/send', messages, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    return resp.data;
  } catch (err) {
    console.error('Expo push error', err.response ? err.response.data : err.message);
    throw err;
  }
}

// ----------------- Routes -----------------

// Health
app.get('/', (req, res) => res.json({ ok: true, msg: 'Security backend running' }));

// ----------------- USERS -----------------

// Create a user (resident/security/admin)
app.post('/api/users', async (req, res) => {
  try {
    const { name, email, password, role, phone, roomId, expoPushToken } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ ok:false, err:'name,email,password,role required' });
    if (!['resident','security','admin'].includes(role)) return res.status(400).json({ ok:false, err:'invalid role' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).json({ ok:false, err:'email already exists' });

    const user = new User({
      name,
      email: email.toLowerCase(),
      password,
      role,
      phone,
      roomId: role === 'resident' ? roomId : undefined,
      expoPushToken
    });
    await user.save();

    // If resident and roomId provided, create or update room doc
    if (role === 'resident' && roomId) {
      const existingRoom = await Room.findOne({ roomLabel: roomId });
      if (!existingRoom) {
        const roomDoc = new Room({ roomLabel: roomId, occupant: name });
        await roomDoc.save();
      } else {
        existingRoom.occupant = name;
        await existingRoom.save();
      }
    }

    res.json({ ok:true, user });
  } catch (err) {
    console.error('Create user error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});

// Single login endpoint (works for all roles)
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ ok:false, err:'email + password required' });

    const user = await User.findOne({ email: email.toLowerCase(), password });
    if (!user) return res.status(401).json({ ok:false, err:'invalid credentials' });

    // Return the user object (no tokens, plain login as requested)
    res.json({ ok:true, user });
  } catch (err) {
    console.error('Login error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});

// List users optionally by role (password hidden)
app.get('/api/users', async (req, res) => {
  try {
    const { role } = req.query;
    const q = {};
    if (role) q.role = role;
    const users = await User.find(q).select('-password').sort({ createdAt: -1 });
    res.json({ ok:true, users });
  } catch (err) {
    res.status(500).json({ ok:false, err: err.message });
  }
});

// Save expo push token by email or roomId
app.post('/api/savePushToken', async (req, res) => {
  try {
    const { email, roomId, expoPushToken } = req.body;
    let user = null;
    if (email) user = await User.findOneAndUpdate({ email: email.toLowerCase() }, { expoPushToken }, { new: true });
    else if (roomId) user = await User.findOneAndUpdate({ roomId }, { expoPushToken }, { new: true });
    else return res.status(400).json({ ok:false, err:'email or roomId required' });

    if (!user) return res.status(404).json({ ok:false, err:'user not found' });
    res.json({ ok:true, user });
  } catch (err) {
    res.status(500).json({ ok:false, err: err.message });
  }
});

// ----------------- ROOMS -----------------
app.post('/api/rooms', async (req, res) => {
  try {
    const { roomLabel, occupant } = req.body;
    if (!roomLabel) return res.status(400).json({ ok:false, err:'roomLabel required' });
    const existing = await Room.findOne({ roomLabel });
    if (existing) return res.status(400).json({ ok:false, err:'room exists' });
    const room = new Room({ roomLabel, occupant });
    await room.save();
    res.json({ ok:true, room });
  } catch (err) {
    res.status(500).json({ ok:false, err: err.message });
  }
});

app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await Room.find().sort({ roomLabel: 1 });
    res.json({ ok: true, rooms });
  } catch (err) {
    res.status(500).json({ ok:false, err: err.message });
  }
});

// ----------------- VISITS -----------------

// Submit a visitor (multipart): roomId, visitorName, purpose, phone(optional), photo(optional)
// Using multer memoryStorage and uploading to Cloudinary
app.post('/api/visitors', upload.single('photo'), async (req, res) => {
  try {
    const { roomId, visitorName, purpose, phone } = req.body;
    if (!roomId || !visitorName) return res.status(400).json({ ok:false, err:'roomId and visitorName required' });

    // 1) Try find room by roomLabel (e.g., "101", "102")
    let roomDoc = await Room.findOne({ roomLabel: roomId });

    // 2) If not found and roomId looks like a valid ObjectId, try findById
    if (!roomDoc && mongoose.Types.ObjectId.isValid(roomId)) {
      roomDoc = await Room.findById(roomId);
    }

    const roomLabel = roomDoc ? roomDoc.roomLabel : roomId;

    // find resident user by roomId or by resolved roomLabel
    let resident = await User.findOne({ role: 'resident', roomId: roomId });
    if (!resident && roomLabel && roomLabel !== roomId) {
      resident = await User.findOne({ role: 'resident', roomId: roomLabel });
    }

    const visitData = {
      roomId,
      roomLabel,
      visitorName,
      purpose,
      phone,
      residentUserId: resident ? resident._id : null
    };

    // If a file was provided, upload to Cloudinary
    if (req.file && req.file.buffer) {
      try {
        const uploadResult = await uploadBufferToCloudinary(req.file.buffer, 'security_visitors');
        // store the secure URL (and optionally public_id)
        visitData.photoPath = uploadResult.secure_url || uploadResult.url;
        visitData.cloudinaryPublicId = uploadResult.public_id;
      } catch (err) {
        console.warn('Cloudinary upload failed:', err.message || err);
        // continue without failing entire request; optionally you can return error
      }
    }

    const visit = new Visit(visitData);
    await visit.save();

    // send expo push to resident if token available
    if (resident && resident.expoPushToken) {
      try {
        await sendExpoPush(
          resident.expoPushToken,
          `Visitor at ${roomLabel}`,
          `${visitorName} — ${purpose || 'No purpose'}`,
          { type: 'visitor', visitId: visit._id }
        );
        visit.notified = true;
        await visit.save();
      } catch (err) {
        console.warn('Push failed:', err.message || err);
      }
    }

    res.json({ ok:true, visit });
  } catch (err) {
    console.error('Visitor submit error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});

// Get visits with optional filters:
// ?date=YYYY-MM-DD (single day, UTC)
// ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive range)
// ?roomId=101&status=pending
app.get('/api/visits', async (req, res) => {
  try {
    const { date, from, to, roomId, status } = req.query;
    const query = {};

    if (roomId) query.roomId = roomId;
    if (status) query.status = status;

    if (date) {
      // single UTC day
      const start = new Date(date + 'T00:00:00.000Z');
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);
      query.createdAt = { $gte: start, $lt: end };
    } else if (from || to) {
      const range = {};
      if (from) range.$gte = new Date(from + 'T00:00:00.000Z');
      if (to) {
        const toDate = new Date(to + 'T00:00:00.000Z');
        toDate.setUTCDate(toDate.getUTCDate() + 1);
        range.$lt = toDate;
      }
      if (Object.keys(range).length) query.createdAt = range;
    }

    const visits = await Visit.find(query).sort({ createdAt: -1 }).limit(2000).populate('residentUserId', 'name email phone roomId role');
    res.json({ ok:true, count: visits.length, visits });
  } catch (err) {
    console.error('Fetch visits error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});

// Update visit status (approve/deny/pending)
app.post('/api/visits/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['approved','denied','pending'].includes(status)) return res.status(400).json({ ok:false, err:'invalid status' });

    const visit = await Visit.findByIdAndUpdate(id, { status }, { new: true });
    if (!visit) return res.status(404).json({ ok:false, err:'visit not found' });

    // notify resident (if token) about status change
    if (visit.residentUserId) {
      const resident = await User.findById(visit.residentUserId);
      if (resident && resident.expoPushToken) {
        try {
          await sendExpoPush(resident.expoPushToken, `Visitor ${status}`, `${visit.visitorName} has been ${status}`, { type:'visit_status', visitId: visit._id, status });
        } catch (e) { /* ignore */ }
      }
    }

    res.json({ ok:true, visit });
  } catch (err) {
    console.error('Update visit status error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});


// DELETE a user by id
// DELETE /api/users/:id?deleteVisits=true
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { deleteVisits } = req.query; // optional flag to delete visits by this user

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ ok:false, err:'invalid user id' });

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ ok:false, err:'user not found' });

    // If resident, clear occupant in any Room that matches their roomId
    if (user.role === 'resident' && user.roomId) {
      await Room.findOneAndUpdate({ roomLabel: user.roomId }, { $unset: { occupant: "" } }, { new: true });
    }

    // Optionally delete all Visit docs referencing this user
    if (deleteVisits === 'true' || deleteVisits === '1') {
      await Visit.deleteMany({ residentUserId: user._id });
    }

    // Finally remove the user
    await User.findByIdAndDelete(id);

    res.json({ ok:true, msg:'user deleted', deletedUserId: id, visitsDeleted: (deleteVisits === 'true' || deleteVisits === '1') });
  } catch (err) {
    console.error('Delete user error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});



// GET visits for a specific month
// GET /api/visits/month?year=2025&month=11&roomId=101&status=approved
app.get('/api/visits/month', async (req, res) => {
  try {
    const { year, month, roomId, status } = req.query;
    if (!year || !month) return res.status(400).json({ ok:false, err:'year and month required (e.g. year=2025&month=11)' });

    const y = parseInt(year, 10);
    const m = parseInt(month, 10); // 1-12
    if (isNaN(y) || isNaN(m) || m < 1 || m > 12) return res.status(400).json({ ok:false, err:'invalid year or month' });

    const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));            // UTC start of month
    const end = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));                  // UTC start of next month

    const query = { createdAt: { $gte: start, $lt: end } };
    if (roomId) query.roomId = roomId;
    if (status) query.status = status;

    const visits = await Visit.find(query).sort({ createdAt: -1 }).limit(5000).populate('residentUserId', 'name email phone roomId role');
    res.json({ ok:true, count: visits.length, visits });
  } catch (err) {
    console.error('Month visits error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});

// GET visits for a specific year
// GET /api/visits/year?year=2025&roomId=101&status=pending
app.get('/api/visits/year', async (req, res) => {
  try {
    const { year, roomId, status } = req.query;
    if (!year) return res.status(400).json({ ok:false, err:'year required (e.g. year=2025)' });

    const y = parseInt(year, 10);
    if (isNaN(y)) return res.status(400).json({ ok:false, err:'invalid year' });

    const start = new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0));          // start of year UTC
    const end = new Date(Date.UTC(y + 1, 0, 1, 0, 0, 0, 0));      // start of next year UTC

    const query = { createdAt: { $gte: start, $lt: end } };
    if (roomId) query.roomId = roomId;
    if (status) query.status = status;

    const visits = await Visit.find(query).sort({ createdAt: -1 }).limit(20000).populate('residentUserId', 'name email phone roomId role');
    res.json({ ok:true, count: visits.length, visits });
  } catch (err) {
    console.error('Year visits error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});


// GET visits for a specific room (flexible)
// GET /api/visits/room/:roomId?status=pending&date=2025-11-28&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=50
app.get('/api/visits/room/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { status, date, from, to, limit } = req.query;

    const query = { roomId };

    if (status) query.status = status;

    // date or range handling (same approach as your /api/visits)
    if (date) {
      const start = new Date(date + 'T00:00:00.000Z');
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);
      query.createdAt = { $gte: start, $lt: end };
    } else if (from || to) {
      const range = {};
      if (from) range.$gte = new Date(from + 'T00:00:00.000Z');
      if (to) {
        const toDate = new Date(to + 'T00:00:00.000Z');
        toDate.setUTCDate(toDate.getUTCDate() + 1);
        range.$lt = toDate;
      }
      if (Object.keys(range).length) query.createdAt = range;
    }

    const lim = Math.min(parseInt(limit || '200', 10), 5000);

    const visits = await Visit.find(query)
      .sort({ createdAt: -1 })
      .limit(lim)
      .populate('residentUserId', 'name email phone roomId role');

    // Normalize photoPath to array for responses (in case schema still stores a string)
    const normalized = visits.map(v => {
      const obj = v.toObject();
      if (!obj.photoPath) obj.photoPath = [];
      else if (typeof obj.photoPath === 'string') obj.photoPath = [obj.photoPath];
      return obj;
    });

    res.json({ ok: true, count: normalized.length, visits: normalized });
  } catch (err) {
    console.error('Fetch visits by room error', err);
    res.status(500).json({ ok: false, err: err.message });
  }
});

// GET latest visit for a specific room
// GET /api/visits/room/:roomId/latest?status=pending
app.get('/api/visits/room/:roomId/latest', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { status } = req.query;

    const query = { roomId };
    if (status) query.status = status;

    const visit = await Visit.findOne(query)
      .sort({ createdAt: -1 })
      .populate('residentUserId', 'name email phone roomId role');

    if (!visit) return res.status(404).json({ ok: false, err: 'no visit found' });

    const obj = visit.toObject();
    if (!obj.photoPath) obj.photoPath = [];
    else if (typeof obj.photoPath === 'string') obj.photoPath = [obj.photoPath];

    res.json({ ok: true, visit: obj });
  } catch (err) {
    console.error('Fetch latest visit error', err);
    res.status(500).json({ ok: false, err: err.message });
  }
});


// ----------------- Start server -----------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));