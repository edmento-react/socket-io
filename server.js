require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"]
  }
});

// Store rooms with their connected clients
const rooms = new Map(); // roomId -> { tv: socket, mobile: socket, createdAt: Date }

// Room cleanup configuration
const ROOM_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Connection statistics
const stats = {
  totalConnections: 0,
  currentConnections: 0,
  activeRooms: 0,
  startTime: new Date()
};

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(limiter);

// Utility functions
const logConnection = (message) => {
  console.log(`[${new Date().toISOString()}] ${message}`);
};

const generateRoomId = () => {
  // Generate a 6-character room ID
  return crypto.randomBytes(3).toString('hex').toUpperCase();
};

const validateDeviceType = (deviceType) => {
  return ['mobile', 'tv'].includes(deviceType);
};

const getRoomInfo = (roomId) => {
  const room = rooms.get(roomId);
  if (!room) return null;
  
  return {
    roomId,
    hasTV: !!room.tv,
    hasMobile: !!room.mobile,
    createdAt: room.createdAt,
    tvId: room.tv?.id,
    mobileId: room.mobile?.id
  };
};

const cleanupRoom = (roomId) => {
  const room = rooms.get(roomId);
  if (room) {
    if (room.tv) room.tv.leave(roomId);
    if (room.mobile) room.mobile.leave(roomId);
    rooms.delete(roomId);
    stats.activeRooms = rooms.size;
    logConnection(`Room ${roomId} cleaned up`);
  }
};

// Periodic room cleanup
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt.getTime() > ROOM_TIMEOUT) {
      logConnection(`Room ${roomId} expired`);
      cleanupRoom(roomId);
    }
  }
}, 60000); // Check every minute

// Routes
app.get('/', (req, res) => {
  res.json({ 
    status: 'Multi-Room Socket.IO Server Running',
    version: '2.0.0',
    uptime: Math.floor((Date.now() - stats.startTime.getTime()) / 1000),
    stats: {
      currentConnections: stats.currentConnections,
      totalConnections: stats.totalConnections,
      activeRooms: rooms.size
    }
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    server: {
      status: 'running',
      uptime: Math.floor((Date.now() - stats.startTime.getTime()) / 1000),
      startTime: stats.startTime.toISOString()
    },
    rooms: {
      active: rooms.size,
      list: Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId))
    },
    statistics: stats
  });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const roomInfo = getRoomInfo(roomId);
  
  if (!roomInfo) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  res.json(roomInfo);
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  stats.totalConnections++;
  stats.currentConnections++;
  socket.connectedAt = new Date().toISOString();
  
  logConnection(`Client connected: ${socket.id}`);

  // Handle TV registration (creates a new room)
  socket.on('register_tv', (data) => {
    try {
      const roomId = data.roomId || generateRoomId();
      
      // Check if room already has a TV
      if (rooms.has(roomId) && rooms.get(roomId).tv) {
        socket.emit('error', { 
          message: 'Room already has a TV connected',
          code: 'ROOM_TV_EXISTS'
        });
        return;
      }
      
      // Create or update room
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          tv: null,
          mobile: null,
          createdAt: new Date()
        });
        stats.activeRooms = rooms.size;
      }
      
      const room = rooms.get(roomId);
      
      // Disconnect previous TV if exists
      if (room.tv && room.tv.id !== socket.id) {
        room.tv.emit('replaced', { message: 'New TV connected' });
        room.tv.leave(roomId);
        room.tv.disconnect();
      }
      
      // Set this socket as the TV for the room
      room.tv = socket;
      socket.roomId = roomId;
      socket.deviceType = 'tv';
      socket.join(roomId);
      
      logConnection(`TV registered in room ${roomId}: ${socket.id}`);
      
      // Send registration confirmation with room ID
      socket.emit('registered', { 
        deviceType: 'tv',
        roomId: roomId,
        clientId: socket.id,
        timestamp: new Date().toISOString()
      });
      
      // Notify mobile if already connected
      if (room.mobile) {
        room.mobile.emit('tv_connected', { 
          status: 'tv_connected',
          clientId: socket.id,
          timestamp: new Date().toISOString()
        });
      }
      
    } catch (error) {
      logConnection(`TV registration error: ${error.message}`);
      socket.emit('error', { 
        message: 'Registration failed',
        code: 'REGISTRATION_ERROR'
      });
    }
  });

  // Handle mobile registration (joins existing room)
  socket.on('register_mobile', (data) => {
    try {
      const { roomId } = data;
      
      if (!roomId) {
        socket.emit('error', { 
          message: 'Room ID is required',
          code: 'ROOM_ID_REQUIRED'
        });
        return;
      }
      
      if (!rooms.has(roomId)) {
        socket.emit('error', { 
          message: 'Room not found',
          code: 'ROOM_NOT_FOUND'
        });
        return;
      }
      
      const room = rooms.get(roomId);
      
      // Disconnect previous mobile if exists
      if (room.mobile && room.mobile.id !== socket.id) {
        room.mobile.emit('replaced', { message: 'New mobile connected' });
        room.mobile.leave(roomId);
        room.mobile.disconnect();
      }
      
      // Set this socket as the mobile for the room
      room.mobile = socket;
      socket.roomId = roomId;
      socket.deviceType = 'mobile';
      socket.join(roomId);
      
      logConnection(`Mobile registered in room ${roomId}: ${socket.id}`);
      
      // Send registration confirmation
      socket.emit('registered', { 
        deviceType: 'mobile',
        roomId: roomId,
        clientId: socket.id,
        connectedTV: !!room.tv,
        timestamp: new Date().toISOString()
      });
      
      // Notify TV about mobile connection
      if (room.tv) {
        room.tv.emit('mobile_connected', { 
          status: 'mobile_connected',
          clientId: socket.id,
          timestamp: new Date().toISOString()
        });
      }
      
    } catch (error) {
      logConnection(`Mobile registration error: ${error.message}`);
      socket.emit('error', { 
        message: 'Registration failed',
        code: 'REGISTRATION_ERROR'
      });
    }
  });

  // Handle slide changes from mobile
  socket.on('slide_change', (data) => {
    if (socket.deviceType === 'mobile' && socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room && room.tv) {
        logConnection(`Room ${socket.roomId} - Slide change: ${data.slideIndex}`);
        room.tv.emit('slide_change', {
          ...data,
          timestamp: new Date().toISOString(),
          from: socket.id
        });
      }
    }
  });

  // Handle PDF scroll from mobile
  socket.on('pdf_scroll', (data) => {
    if (socket.deviceType === 'mobile' && socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room && room.tv) {
        logConnection(`Room ${socket.roomId} - PDF scroll: ${data.scrollOffset}`);
        room.tv.emit('pdf_scroll', {
          ...data,
          timestamp: new Date().toISOString(),
          from: socket.id
        });
      }
    }
  });

  // Handle PDF page change from mobile
  socket.on('pdf_page_change', (data) => {
    if (socket.deviceType === 'mobile' && socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room && room.tv) {
        logConnection(`Room ${socket.roomId} - PDF page: ${data.pageNumber}`);
        room.tv.emit('pdf_page_change', {
          ...data,
          timestamp: new Date().toISOString(),
          from: socket.id
        });
      }
    }
  });

  // Handle presentation actions
  socket.on('presentation_action', (data) => {
    if (socket.deviceType === 'mobile' && socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room && room.tv) {
        logConnection(`Room ${socket.roomId} - Action: ${data.action}`);
        room.tv.emit('presentation_action', {
          ...data,
          timestamp: new Date().toISOString(),
          from: socket.id
        });
      }
    }
  });

  // Handle document loading
  socket.on('load_document', (data) => {
    if (socket.deviceType === 'mobile' && socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room && room.tv) {
        logConnection(`Room ${socket.roomId} - Load document: ${data.documentType}`);
        room.tv.emit('load_document', {
          ...data,
          timestamp: new Date().toISOString(),
          from: socket.id
        });
      }
    }
  });

  // Handle custom events
  socket.on('custom_event', (data) => {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        // Forward to the other device in the room
        if (socket.deviceType === 'mobile' && room.tv) {
          room.tv.emit('custom_event', {
            ...data,
            timestamp: new Date().toISOString(),
            from: socket.id
          });
        } else if (socket.deviceType === 'tv' && room.mobile) {
          room.mobile.emit('custom_event', {
            ...data,
            timestamp: new Date().toISOString(),
            from: socket.id
          });
        }
      }
    }
  });

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    stats.currentConnections--;
    logConnection(`Client disconnected: ${socket.id} - Reason: ${reason}`);
    
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        if (socket.deviceType === 'tv') {
          room.tv = null;
          // Notify mobile about TV disconnection
          if (room.mobile) {
            room.mobile.emit('tv_disconnected', { 
              status: 'disconnected',
              reason: reason,
              timestamp: new Date().toISOString()
            });
          }
        } else if (socket.deviceType === 'mobile') {
          room.mobile = null;
          // Notify TV about mobile disconnection
          if (room.tv) {
            room.tv.emit('mobile_disconnected', { 
              status: 'disconnected',
              reason: reason,
              timestamp: new Date().toISOString()
            });
          }
        }
        
        // Clean up empty rooms
        if (!room.tv && !room.mobile) {
          cleanupRoom(socket.roomId);
        }
      }
    }
  });

  // Ping-pong for connection health
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: new Date().toISOString() });
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  logConnection(`Multi-Room Socket.IO Server running on port ${PORT}`);
  logConnection(`API status available at http://localhost:${PORT}/api/status`);
});