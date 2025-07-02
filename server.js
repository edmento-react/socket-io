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
  mobileConnections: 0,
  tvConnections: 0,
  startTime: new Date()
};

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
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

const getConnectionStatus = () => {
  const roomsArray = Array.from(rooms.values());
  return {
    totalRooms: rooms.size,
    connectedTVs: roomsArray.filter(room => room.tv).length,
    connectedMobiles: roomsArray.filter(room => room.mobile).length,
    fullyConnectedRooms: roomsArray.filter(room => room.tv && room.mobile).length
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

// Routes
app.get('/', (req, res) => {
  res.json({ 
    status: 'Multi-Room Socket.IO Presentation Server Running',
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
    connections: getConnectionStatus(),
    rooms: {
      active: rooms.size,
      list: Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId))
    },
    statistics: stats
  });
});

app.get('/api/rooms', (req, res) => {
  const roomsList = Array.from(rooms.keys()).map(roomId => getRoomInfo(roomId));
  res.json({
    total: rooms.size,
    rooms: roomsList
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// POST API: Send message to specific room
app.post('/api/message', (req, res) => {
  const { message, roomId } = req.body;
  
  if (!message) {
    return res.status(400).json({ status: 'error', error: 'Message is required' });
  }
  
  if (!roomId) {
    return res.status(400).json({ status: 'error', error: 'Room ID is required' });
  }
  
  logConnection(`Received POST message for room ${roomId}: ${message}`);
  
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ status: 'error', error: 'Room not found' });
  }
  
  // Broadcast to TV in the specific room
  if (room.tv) {
    room.tv.emit('message_from_api', {
      message,
      timestamp: new Date().toISOString()
    });
    res.json({ status: 'sent', message, roomId });
  } else {
    res.status(404).json({ status: 'error', error: 'No TV connected in this room' });
  }
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
        stats.tvConnections--;
      }
      
      // Set this socket as the TV for the room
      room.tv = socket;
      socket.roomId = roomId;
      socket.deviceType = 'tv';
      socket.join(roomId);
      stats.tvConnections++;
      
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
        stats.mobileConnections--;
      }
      
      // Set this socket as the mobile for the room
      room.mobile = socket;
      socket.roomId = roomId;
      socket.deviceType = 'mobile';
      socket.join(roomId);
      stats.mobileConnections++;
      
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
    try {
      if (socket.deviceType === 'mobile' && socket.roomId) {
        const room = rooms.get(socket.roomId);
        if (room && room.tv) {
          if (typeof data.slideIndex !== 'number') {
            throw new Error('Invalid slide index');
          }
          logConnection(`Room ${socket.roomId} - Slide change: ${data.slideIndex}`);
          room.tv.emit('slide_change', {
            ...data,
            timestamp: new Date().toISOString(),
            from: socket.id
          });
        } else {
          socket.emit('error', { 
            message: 'TV not connected in this room',
            code: 'NO_TV_IN_ROOM'
          });
        }
      } else {
        socket.emit('error', { 
          message: 'Unauthorized',
          code: 'UNAUTHORIZED'
        });
      }
    } catch (error) {
      logConnection(`Slide change error: ${error.message}`);
      socket.emit('error', { 
        message: 'Invalid slide change data',
        code: 'INVALID_SLIDE_DATA'
      });
    }
  });

  // Handle PDF scroll from mobile
  socket.on('pdf_scroll', (data) => {
    try {
      if (socket.deviceType === 'mobile' && socket.roomId) {
        const room = rooms.get(socket.roomId);
        if (room && room.tv) {
          if (typeof data.scrollOffset !== 'number') {
            throw new Error('Invalid scroll offset');
          }
          logConnection(`Room ${socket.roomId} - PDF scroll: offset ${data.scrollOffset}, page ${data.pageNumber || 'unknown'}`);
          room.tv.emit('pdf_scroll', {
            ...data,
            timestamp: new Date().toISOString(),
            from: socket.id
          });
        } else {
          socket.emit('error', { 
            message: 'TV not connected in this room',
            code: 'NO_TV_IN_ROOM'
          });
        }
      } else {
        socket.emit('error', { 
          message: 'Unauthorized',
          code: 'UNAUTHORIZED'
        });
      }
    } catch (error) {
      logConnection(`PDF scroll error: ${error.message}`);
      socket.emit('error', { 
        message: 'Invalid PDF scroll data',
        code: 'INVALID_SCROLL_DATA'
      });
    }
  });

  // Handle PDF page change from mobile
  socket.on('pdf_page_change', (data) => {
    try {
      if (socket.deviceType === 'mobile' && socket.roomId) {
        const room = rooms.get(socket.roomId);
        if (room && room.tv) {
          if (typeof data.pageNumber !== 'number') {
            throw new Error('Invalid page number');
          }
          logConnection(`Room ${socket.roomId} - PDF page change: ${data.pageNumber}`);
          room.tv.emit('pdf_page_change', {
            ...data,
            timestamp: new Date().toISOString(),
            from: socket.id
          });
        } else {
          socket.emit('error', { 
            message: 'TV not connected in this room',
            code: 'NO_TV_IN_ROOM'
          });
        }
      } else {
        socket.emit('error', { 
          message: 'Unauthorized',
          code: 'UNAUTHORIZED'
        });
      }
    } catch (error) {
      logConnection(`PDF page change error: ${error.message}`);
      socket.emit('error', { 
        message: 'Invalid PDF page data',
        code: 'INVALID_PAGE_DATA'
      });
    }
  });

  // Handle presentation actions from mobile
  socket.on('presentation_action', (data) => {
    try {
      if (socket.deviceType === 'mobile' && socket.roomId) {
        const room = rooms.get(socket.roomId);
        if (room && room.tv) {
          const validActions = ['play', 'pause', 'stop', 'next', 'previous', 'fullscreen', 'exit_fullscreen'];
          if (!validActions.includes(data.action)) {
            throw new Error('Invalid action');
          }
          logConnection(`Room ${socket.roomId} - Presentation action: ${data.action}`);
          room.tv.emit('presentation_action', {
            ...data,
            timestamp: new Date().toISOString(),
            from: socket.id
          });
        } else {
          socket.emit('error', { 
            message: 'TV not connected in this room',
            code: 'NO_TV_IN_ROOM'
          });
        }
      } else {
        socket.emit('error', { 
          message: 'Unauthorized',
          code: 'UNAUTHORIZED'
        });
      }
    } catch (error) {
      logConnection(`Presentation action error: ${error.message}`);
      socket.emit('error', { 
        message: 'Invalid presentation action',
        code: 'INVALID_ACTION'
      });
    }
  });

  // Handle document/media loading
  socket.on('load_document', (data) => {
    try {
      if (socket.deviceType === 'mobile' && socket.roomId) {
        const room = rooms.get(socket.roomId);
        if (room && room.tv) {
          const validTypes = ['pdf', 'powerpoint', 'image', 'video'];
          if (!validTypes.includes(data.documentType)) {
            throw new Error('Invalid document type');
          }
          logConnection(`Room ${socket.roomId} - Load document: ${data.documentType} - ${data.documentUrl || data.documentName || 'unknown'}`);
          room.tv.emit('load_document', {
            ...data,
            timestamp: new Date().toISOString(),
            from: socket.id
          });
        } else {
          socket.emit('error', { 
            message: 'TV not connected in this room',
            code: 'NO_TV_IN_ROOM'
          });
        }
      } else {
        socket.emit('error', { 
          message: 'Unauthorized',
          code: 'UNAUTHORIZED'
        });
      }
    } catch (error) {
      logConnection(`Load document error: ${error.message}`);
      socket.emit('error', { 
        message: 'Invalid document data',
        code: 'INVALID_DOCUMENT_DATA'
      });
    }
  });

  // Handle custom events
  socket.on('custom_event', (data) => {
    try {
      if (socket.roomId) {
        const room = rooms.get(socket.roomId);
        if (room) {
          logConnection(`Room ${socket.roomId} - Custom event: ${data.eventType || 'unknown'}`);
          
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
          } else {
            socket.emit('error', { 
              message: 'Other device not connected in this room',
              code: 'DEVICE_NOT_CONNECTED'
            });
          }
        } else {
          socket.emit('error', { 
            message: 'Room not found',
            code: 'ROOM_NOT_FOUND'
          });
        }
      } else {
        socket.emit('error', { 
          message: 'Not in a room',
          code: 'NO_ROOM'
        });
      }
    } catch (error) {
      logConnection(`Custom event error: ${error.message}`);
      socket.emit('error', { 
        message: 'Invalid custom event data',
        code: 'INVALID_CUSTOM_EVENT'
      });
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
          stats.tvConnections--;
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
          stats.mobileConnections--;
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

  // Handle errors
  socket.on('error', (error) => {
    logConnection(`Socket error for ${socket.id}: ${error.message || error}`);
  });

  // Ping-pong for connection health
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: new Date().toISOString() });
  });

  // Handle pong responses
  socket.on('pong', () => {
    socket.lastPong = new Date();
  });
});

// Health check interval - ping clients every 30 seconds
setInterval(() => {
  const now = new Date();
  
  for (const [roomId, room] of rooms.entries()) {
    if (room.mobile) {
      room.mobile.emit('ping', { timestamp: now.toISOString() });
    }
    if (room.tv) {
      room.tv.emit('ping', { timestamp: now.toISOString() });
    }
  }
}, 30000);

// Cleanup disconnected clients every 60 seconds
setInterval(() => {
  const now = new Date();
  const timeout = 60000; // 60 seconds timeout
  
  for (const [roomId, room] of rooms.entries()) {
    let shouldCleanup = false;
    
    if (room.mobile && room.mobile.lastPong && (now - room.mobile.lastPong) > timeout) {
      logConnection(`Mobile client ${room.mobile.id} in room ${roomId} timed out`);
      room.mobile.disconnect();
      room.mobile = null;
      shouldCleanup = !room.tv;
    }
    
    if (room.tv && room.tv.lastPong && (now - room.tv.lastPong) > timeout) {
      logConnection(`TV client ${room.tv.id} in room ${roomId} timed out`);
      room.tv.disconnect();
      room.tv = null;
      shouldCleanup = shouldCleanup || !room.mobile;
    }
    
    if (shouldCleanup) {
      cleanupRoom(roomId);
    }
  }
}, 60000);

// Periodic room cleanup - remove old empty rooms
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt.getTime() > ROOM_TIMEOUT) {
      logConnection(`Room ${roomId} expired`);
      cleanupRoom(roomId);
    }
  }
}, 60000); // Check every minute

// Graceful shutdown
process.on('SIGTERM', () => {
  logConnection('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logConnection('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logConnection('SIGINT received, shutting down gracefully');
  server.close(() => {
    logConnection('Server closed');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  logConnection(`Multi-Room Socket.IO Presentation Server running on port ${PORT}`);
  logConnection(`Health check available at http://localhost:${PORT}/health`);
  logConnection(`API status available at http://localhost:${PORT}/api/status`);
});

module.exports = { app, server, io };