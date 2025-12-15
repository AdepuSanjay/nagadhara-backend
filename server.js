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
app.use(bodyParser.json({ limit: '10mb' }));

// ----------------- Cloudinary (inlined as requested) ----------------- //
// WARNING: move these to env vars for production
cloudinary.config({
  cloud_name: "dppiuypop",
  api_key: "412712715735329",
  api_secret: "m04IUY0-awwtr4YoS-1xvxOOIzU",
});

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

const UserSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }, // plain text (as requested)
  role: { type: String, enum: ['resident','security','admin'], default: 'resident' },
  phone: { type: String },
  roomId: { type: String },
  // Support multiple devices per user (set semantics enforced in code)
  expoPushTokens: { type: [String], default: [] },
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
  photoPath: { type: [String], default: [] }, // store Cloudinary secure_url(s) as array
  status: { type: String, default: 'pending' }, // pending, approved, denied
  notified: { type: Boolean, default: false },
  residentUserId: { type: mongoose.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

VisitSchema.index({ roomId: 1, createdAt: -1 });

const User = mongoose.model('User', UserSchema);
const Room = mongoose.model('Room', RoomSchema);
const Visit = mongoose.model('Visit', VisitSchema);

// ----------------- multer (memory storage for direct Cloudinary upload) -----------------
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ----------------- Expo Push helper -----------------
// Send push notifications to multiple Expo tokens (batches of 100 allowed per request)
// messages are built for each token with same title/body/data/android settings
async function sendExpoPushToTokens(tokens = [], title = '', body = '', data = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) return { ok: true, sent: 0 };

  // Build message array (one message per token) — use the new channel id 'visitor_alerts'
  const messages = tokens.map(token => ({
  to: token,
  title,
  body,
  channelId: 'visitor_alerts', // ✅ MUST be top-level
  sound: 'ring.wav',           // ✅ full filename
  priority: 'high',
  data
}));
  // Expo accepts up to ~100 messages per request; we'll chunk to be safe
  const CHUNK_SIZE = 100;
  let sent = 0;
  const details = [];

  try {
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      const chunk = messages.slice(i, i + CHUNK_SIZE);
      const resp = await axios.post('https://exp.host/--/api/v2/push/send', chunk, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });

      if (resp && resp.status >= 200 && resp.status < 300) {
        // Best-effort count: assume chunk accepted (you can parse resp.data for exact tickets if needed)
        sent += chunk.length;
        details.push({ ok: true, status: resp.status, length: chunk.length });
      } else {
        console.warn('Expo push chunk responded with non-2xx', resp && resp.status);
        details.push({ ok: false, status: resp && resp.status });
      }
    }

    return { ok: true, sent, details };
  } catch (err) {
    console.error('Expo push error', err.response ? err.response.data || err.response.status : err.message);
    return { ok: false, sent, error: err.response ? err.response.data : err.message };
  }
}
// ----------------- Routes -----------------
app.get('/', (req, res) => res.json({ ok: true, msg: 'Security backend running' }));

// Create a user
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
      expoPushTokens: Array.isArray(expoPushToken) ? expoPushToken : (expoPushToken ? [expoPushToken] : [])
    });
    await user.save();

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

    const out = user.toObject();
    delete out.password;
    res.json({ ok:true, user: out });
  } catch (err) {
    console.error('Create user error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});



app.post('/api/login', async (req, res) => {
  try {
    const { email, password, expoPushToken } = req.body;
    if (!email || !password)
      return res.status(400).json({ ok:false, err:'email + password required' });

    const user = await User.findOne({ email: email.toLowerCase(), password });
    if (!user)
      return res.status(401).json({ ok:false, err:'invalid credentials' });

    if (expoPushToken) {
      // 🔥 STEP 1: Remove this token from ALL other users
      await User.updateMany(
        { _id: { $ne: user._id } },
        { $pull: { expoPushTokens: expoPushToken } }
      );

      // 🔥 STEP 2: Add token to current user if not exists
      if (!user.expoPushTokens.includes(expoPushToken)) {
        user.expoPushTokens.push(expoPushToken);
        await user.save();
      }
    }

    const out = user.toObject();
    delete out.password;
    res.json({ ok:true, user: out });

  } catch (err) {
    console.error('Login error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});


app.post('/api/logout', async (req, res) => {
  try {
    const { userId, expoPushToken } = req.body;

    if (!userId || !expoPushToken)
      return res.status(400).json({ ok:false, err:'userId & expoPushToken required' });

    if (!mongoose.Types.ObjectId.isValid(userId))
      return res.status(400).json({ ok:false, err:'invalid userId' });

    await User.findByIdAndUpdate(
      userId,
      { $pull: { expoPushTokens: expoPushToken } }
    );

    res.json({ ok:true, msg:'Logout successful, token removed' });
  } catch (err) {
    console.error('Logout error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});





app.post('/api/users/:id/push-token', async (req, res) => {
  try {
    const { id } = req.params;
    const { expoPushToken } = req.body;

    if (!expoPushToken)
      return res.status(400).json({ ok:false, err:'expoPushToken required' });

    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ ok:false, err:'invalid id' });

    // 🔥 Remove token from all other users
    await User.updateMany(
      { _id: { $ne: id } },
      { $pull: { expoPushTokens: expoPushToken } }
    );

    const user = await User.findById(id);
    if (!user)
      return res.status(404).json({ ok:false, err:'user not found' });

    if (!user.expoPushTokens.includes(expoPushToken)) {
      user.expoPushTokens.push(expoPushToken);
      await user.save();
    }

    const out = user.toObject();
    delete out.password;
    res.json({ ok:true, user: out });

  } catch (err) {
    console.error('Update push token error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});







// List users
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

// Rooms
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

// Submit a visitor (multipart)
app.post('/api/visitors', upload.single('photo'), async (req, res) => {
  try {
    const { roomId, visitorName, purpose, phone } = req.body;
    if (!roomId || !visitorName) return res.status(400).json({ ok:false, err:'roomId and visitorName required' });

    let roomDoc = await Room.findOne({ roomLabel: roomId });
    if (!roomDoc && mongoose.Types.ObjectId.isValid(roomId)) {
      roomDoc = await Room.findById(roomId);
    }
    const roomLabel = roomDoc ? roomDoc.roomLabel : roomId;

    // Find resident(s) by roomId (could be multiple residents)
    let residents = await User.find({ role: 'resident', roomId: roomId });
    if ((!residents || residents.length === 0) && roomLabel && roomLabel !== roomId) {
      residents = await User.find({ role: 'resident', roomId: roomLabel });
    }

    const visitData = {
      roomId,
      roomLabel,
      visitorName,
      purpose,
      phone,
      residentUserId: (residents && residents[0]) ? residents[0]._id : null,
      photoPath: []
    };

    if (req.file && req.file.buffer) {
      try {
        const uploadResult = await uploadBufferToCloudinary(req.file.buffer, 'security_visitors');
        if (uploadResult && (uploadResult.secure_url || uploadResult.url)) {
          visitData.photoPath.push(uploadResult.secure_url || uploadResult.url);
          visitData.cloudinaryPublicId = uploadResult.public_id;
        }
      } catch (err) {
        console.warn('Cloudinary upload failed:', err.message || err);
      }
    }

    const visit = new Visit(visitData);
    await visit.save();

    // Send push to all resident tokens (if any)
    if (residents && residents.length > 0) {
      // collect tokens from all matched residents (dedupe)
      const tokensSet = new Set();
      residents.forEach(r => {
        (r.expoPushTokens || []).forEach(t => {
          if (t) tokensSet.add(t);
        });
      });
      const tokens = Array.from(tokensSet);
      if (tokens.length > 0) {
        try {
          const result = await sendExpoPushToTokens(
            tokens,
            `Visitor at ${roomLabel}`,
            `${visitorName} — ${purpose || 'No purpose'}`,
            { type: 'visitor', visitId: visit._id }
          );
          if (result && result.ok) {
            visit.notified = true;
            await visit.save();
          }
        } catch (err) {
          console.warn('Push failed:', err.message || err);
        }
      }
    }

    const obj = visit.toObject();
    if (!obj.photoPath) obj.photoPath = [];
    res.json({ ok:true, visit: obj });
  } catch (err) {
    console.error('Visitor submit error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});

// Generic visits listing
app.get('/api/visits', async (req, res) => {
  try {
    const { date, from, to, roomId, status } = req.query;
    const query = {};
    if (roomId) query.roomId = roomId;
    if (status) query.status = status;

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

    const visits = await Visit.find(query).sort({ createdAt: -1 }).limit(2000).populate('residentUserId', 'name email phone roomId role');
    const normalized = visits.map(v => {
      const obj = v.toObject();
      if (!obj.photoPath) obj.photoPath = [];
      else if (typeof obj.photoPath === 'string') obj.photoPath = [obj.photoPath];
      return obj;
    });

    res.json({ ok:true, count: normalized.length, visits: normalized });
  } catch (err) {
    console.error('Fetch visits error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});

// Update visit status
app.post('/api/visits/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['approved','denied','pending'].includes(status)) return res.status(400).json({ ok:false, err:'invalid status' });

    const visit = await Visit.findByIdAndUpdate(id, { status }, { new: true }).populate('residentUserId', 'name email phone roomId role');
    if (!visit) return res.status(404).json({ ok:false, err:'visit not found' });

    if (visit.residentUserId) {
      const resident = await User.findById(visit.residentUserId);
      if (resident && (resident.expoPushTokens || []).length > 0) {
        try {
          await sendExpoPushToTokens(resident.expoPushTokens, `Visitor ${status}`, `${visit.visitorName} has been ${status}`, { type:'visit_status', visitId: visit._id, status });
        } catch (e) { /* ignore push errors */ }
      }
    }

    const obj = visit.toObject();
    if (!obj.photoPath) obj.photoPath = [];
    res.json({ ok:true, visit: obj });
  } catch (err) {
    console.error('Update visit status error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});

// Delete user
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { deleteVisits } = req.query;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ ok:false, err:'invalid user id' });

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ ok:false, err:'user not found' });

    if (user.role === 'resident' && user.roomId) {
      await Room.findOneAndUpdate({ roomLabel: user.roomId }, { $unset: { occupant: "" } }, { new: true });
    }

    if (deleteVisits === 'true' || deleteVisits === '1') {
      await Visit.deleteMany({ residentUserId: user._id });
    }

    await User.findByIdAndDelete(id);

    res.json({ ok:true, msg:'user deleted', deletedUserId: id, visitsDeleted: (deleteVisits === 'true' || deleteVisits === '1') });
  } catch (err) {
    console.error('Delete user error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});

// Month / Year endpoints
app.get('/api/visits/month', async (req, res) => {
  try {
    const { year, month, roomId, status } = req.query;
    if (!year || !month) return res.status(400).json({ ok:false, err:'year and month required (e.g. year=2025&month=11)' });

    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    if (isNaN(y) || isNaN(m) || m < 1 || m > 12) return res.status(400).json({ ok:false, err:'invalid year or month' });

    const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));

    const query = { createdAt: { $gte: start, $lt: end } };
    if (roomId) query.roomId = roomId;
    if (status) query.status = status;

    const visits = await Visit.find(query).sort({ createdAt: -1 }).limit(5000).populate('residentUserId', 'name email phone roomId role');
    const normalized = visits.map(v => {
      const obj = v.toObject();
      if (!obj.photoPath) obj.photoPath = [];
      else if (typeof obj.photoPath === 'string') obj.photoPath = [obj.photoPath];
      return obj;
    });

    res.json({ ok:true, count: normalized.length, visits: normalized });
  } catch (err) {
    console.error('Month visits error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});

app.get('/api/visits/year', async (req, res) => {
  try {
    const { year, roomId, status } = req.query;
    if (!year) return res.status(400).json({ ok:false, err:'year required (e.g. year=2025)' });

    const y = parseInt(year, 10);
    if (isNaN(y)) return res.status(400).json({ ok:false, err:'invalid year' });

    const start = new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(y + 1, 0, 1, 0, 0, 0, 0));

    const query = { createdAt: { $gte: start, $lt: end } };
    if (roomId) query.roomId = roomId;
    if (status) query.status = status;

    const visits = await Visit.find(query).sort({ createdAt: -1 }).limit(20000).populate('residentUserId', 'name email phone roomId role');
    const normalized = visits.map(v => {
      const obj = v.toObject();
      if (!obj.photoPath) obj.photoPath = [];
      else if (typeof obj.photoPath === 'string') obj.photoPath = [obj.photoPath];
      return obj;
    });

    res.json({ ok:true, count: normalized.length, visits: normalized });
  } catch (err) {
    console.error('Year visits error', err);
    res.status(500).json({ ok:false, err: err.message });
  }
});

// GET visits for a specific room
app.get('/api/visits/room/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { status, date, from, to, limit } = req.query;
    const query = { roomId };

    if (status) query.status = status;

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