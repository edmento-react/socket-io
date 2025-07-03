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
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["*"],
    credentials: true
  },
  allowEIO3: true,
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
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
  max: 1000, // Increased limit for development
  message: { error: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Middleware
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["*"],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(limiter);

// Utility functions
const logConnection = (message) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
};

const generateRoomId = () => {
  // Generate a 6-character room ID (alphanumeric, avoiding confusing characters)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const validateRoomId = (roomId) => {
  return roomId && typeof roomId === 'string' && roomId.length >= 4;
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
    mobileId: room.mobile?.id,
    tvConnected: room.tv?.connected || false,
    mobileConnected: room.mobile?.connected || false
  };
};

const getConnectionStatus = () => {
  const roomsArray = Array.from(rooms.values());
  return {
    totalRooms: rooms.size,
    connectedTVs: roomsArray.filter(room => room.tv && room.tv.connected).length,
    connectedMobiles: roomsArray.filter(room => room.mobile && room.mobile.connected).length,
    fullyConnectedRooms: roomsArray.filter(room => room.tv && room.mobile && room.tv.connected && room.mobile.connected).length
  };
};

const cleanupRoom = (roomId, reason = 'cleanup') => {
  const room = rooms.get(roomId);
  if (room) {
    logConnection(`Cleaning up room ${roomId} - Reason: ${reason}`);
    
    if (room.tv && room.tv.connected) {
      room.tv.leave(roomId);
      room.tv.emit('room_cleanup', { reason });
    }
    if (room.mobile && room.mobile.connected) {
      room.mobile.leave(roomId);
      room.mobile.emit('room_cleanup', { reason });
    }
    
    rooms.delete(roomId);
    stats.activeRooms = rooms.size;
    logConnection(`Room ${roomId} cleaned up successfully`);
  }
};

const notifyRoomDevices = (roomId, eventName, data, excludeSocket = null) => {
  const room = rooms.get(roomId);
  if (!room) return;
  
  const timestamp = new Date().toISOString();
  const eventData = { ...data, timestamp, roomId };
  
  if (room.tv && room.tv.connected && room.tv !== excludeSocket) {
    room.tv.emit(eventName, eventData);
  }
  if (room.mobile && room.mobile.connected && room.mobile !== excludeSocket) {
    room.mobile.emit(eventName, eventData);
  }
};

// Routes
app.get('/', (req, res) => {
  res.json({ 
    status: 'Flutter Socket.IO Presentation Server Running',
    version: '2.2.0',
    uptime: Math.floor((Date.now() - stats.startTime.getTime()) / 1000),
    stats: {
      currentConnections: stats.currentConnections,
      totalConnections: stats.totalConnections,
      activeRooms: rooms.size,
      mobileConnections: stats.mobileConnections,
      tvConnections: stats.tvConnections
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    server: {
      status: 'running',
      version: '2.2.0',
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
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - stats.startTime.getTime()) / 1000),
    connections: stats.currentConnections
  });
});

// API endpoint to send messages to specific rooms
app.post('/api/rooms/:roomId/message', (req, res) => {
  const { roomId } = req.params;
  const { message, target = 'tv' } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }
  
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  const targetDevice = target === 'mobile' ? room.mobile : room.tv;
  if (!targetDevice || !targetDevice.connected) {
    return res.status(404).json({ error: `${target} not connected in this room` });
  }
  
  targetDevice.emit('api_message', {
    message,
    timestamp: new Date().toISOString(),
    from: 'api'
  });
  
  logConnection(`API message sent to ${target} in room ${roomId}: ${message}`);
  res.json({ status: 'sent', message, target, roomId });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  stats.totalConnections++;
  stats.currentConnections++;
  socket.connectedAt = new Date().toISOString();
  socket.isHealthy = true;
  
  logConnection(`Client connected: ${socket.id} from ${socket.handshake.address} using ${socket.conn.transport.name}`);

  // Handle TV registration (creates a new room)
  socket.on('register_tv', (data) => {
    try {
      logConnection(`TV registration request: ${JSON.stringify(data)} from ${socket.id}`);
      
      // Convert numeric room ID to string if needed, or generate new one
      let roomId = data?.roomId ? data.roomId.toString() : generateRoomId();
      
      // Validate room ID
      if (!validateRoomId(roomId)) {
        roomId = generateRoomId();
        logConnection(`Invalid room ID provided, generated new one: ${roomId}`);
      }
      
      // Check if room already has a TV
      if (rooms.has(roomId) && rooms.get(roomId).tv?.connected) {
        logConnection(`Room ${roomId} already has a connected TV, replacing...`);
        const existingRoom = rooms.get(roomId);
        if (existingRoom.tv && existingRoom.tv.id !== socket.id) {
          existingRoom.tv.emit('replaced', { 
            message: 'New TV connected to this room',
            timestamp: new Date().toISOString()
          });
          existingRoom.tv.leave(roomId);
          if (existingRoom.tv.connected) {
            existingRoom.tv.disconnect(true);
          }
          stats.tvConnections = Math.max(0, stats.tvConnections - 1);
        }
      }
      
      // Create or update room
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          tv: null,
          mobile: null,
          createdAt: new Date()
        });
        stats.activeRooms = rooms.size;
        logConnection(`Created new room: ${roomId}`);
      }
      
      const room = rooms.get(roomId);
      
      // Set this socket as the TV for the room
      room.tv = socket;
      socket.roomId = roomId;
      socket.deviceType = 'tv';
      socket.deviceName = data?.deviceName || 'TV Display';
      socket.join(roomId);
      stats.tvConnections++;
      
      logConnection(`TV registered successfully in room ${roomId}: ${socket.id}`);
      
      // Send registration confirmation with room ID
      socket.emit('registered', { 
        deviceType: 'tv',
        roomId: roomId,
        clientId: socket.id,
        timestamp: new Date().toISOString(),
        message: 'TV registered successfully'
      });
      
      // Notify mobile if already connected
      if (room.mobile && room.mobile.connected) {
        room.mobile.emit('tv_connected', { 
          status: 'tv_connected',
          deviceId: socket.id,
          deviceName: socket.deviceName,
          timestamp: new Date().toISOString()
        });
        
        // Also notify TV about existing mobile
        socket.emit('mobile_connected', {
          status: 'mobile_connected',
          deviceId: room.mobile.id,
          deviceName: room.mobile.deviceName || 'Mobile Controller',
          timestamp: new Date().toISOString()
        });
        
        logConnection(`Notified devices about existing connections in room ${roomId}`);
      }
      
    } catch (error) {
      logConnection(`TV registration error: ${error.message}`);
      socket.emit('error', { 
        message: 'TV registration failed',
        code: 'TV_REGISTRATION_ERROR',
        details: error.message
      });
    }
  });

  // Handle mobile registration (joins existing room)
  socket.on('register_mobile', (data) => {
    try {
      logConnection(`Mobile registration request: ${JSON.stringify(data)} from ${socket.id}`);
      
      const roomId = data?.roomId ? data.roomId.toString() : null;
      
      if (!roomId) {
        socket.emit('error', { 
          message: 'Room ID is required for mobile registration',
          code: 'ROOM_ID_REQUIRED'
        });
        return;
      }
      
      if (!validateRoomId(roomId)) {
        socket.emit('error', { 
          message: 'Invalid room ID format',
          code: 'INVALID_ROOM_ID'
        });
        return;
      }
      
      if (!rooms.has(roomId)) {
        logConnection(`Room ${roomId} not found for mobile registration`);
        socket.emit('error', { 
          message: 'Room not found. Make sure the TV is connected and displaying the correct room code.',
          code: 'ROOM_NOT_FOUND',
          roomId: roomId
        });
        return;
      }
      
      const room = rooms.get(roomId);
      
      // Check if TV is connected
      if (!room.tv || !room.tv.connected) {
        logConnection(`No TV connected in room ${roomId} for mobile registration`);
        socket.emit('error', { 
          message: 'No TV connected in this room. Please make sure the TV is online.',
          code: 'NO_TV_IN_ROOM',
          roomId: roomId
        });
        return;
      }
      
      // Disconnect previous mobile if exists
      if (room.mobile && room.mobile.connected && room.mobile.id !== socket.id) {
        logConnection(`Replacing existing mobile in room ${roomId}`);
        room.mobile.emit('replaced', { 
          message: 'New mobile device connected to this room',
          timestamp: new Date().toISOString()
        });
        room.mobile.leave(roomId);
        room.mobile.disconnect(true);
        stats.mobileConnections = Math.max(0, stats.mobileConnections - 1);
      }
      
      // Set this socket as the mobile for the room
      room.mobile = socket;
      socket.roomId = roomId;
      socket.deviceType = 'mobile';
      socket.deviceName = data?.deviceName || 'Mobile Controller';
      socket.join(roomId);
      stats.mobileConnections++;
      
      logConnection(`Mobile registered successfully in room ${roomId}: ${socket.id}`);
      
      // Send registration confirmation
      socket.emit('registered', { 
        deviceType: 'mobile',
        roomId: roomId,
        clientId: socket.id,
        connectedTV: true,
        tvId: room.tv.id,
        timestamp: new Date().toISOString(),
        message: 'Mobile registered successfully'
      });
      
      // Notify TV about mobile connection
      room.tv.emit('mobile_connected', { 
        status: 'mobile_connected',
        deviceId: socket.id,
        deviceName: socket.deviceName,
        timestamp: new Date().toISOString()
      });
      
      logConnection(`Room ${roomId} now has both TV and mobile connected`);
      
    } catch (error) {
      logConnection(`Mobile registration error: ${error.message}`);
      socket.emit('error', { 
        message: 'Mobile registration failed',
        code: 'MOBILE_REGISTRATION_ERROR',
        details: error.message
      });
    }
  });

  // Handle slide changes from mobile
  socket.on('slide_change', (data) => {
    try {
      if (socket.deviceType !== 'mobile' || !socket.roomId) {
        socket.emit('error', { 
          message: 'Unauthorized: Only mobile devices in a room can change slides',
          code: 'UNAUTHORIZED_SLIDE_CHANGE'
        });
        return;
      }
      
      const room = rooms.get(socket.roomId);
      if (!room?.tv?.connected) {
        socket.emit('error', { 
          message: 'TV not connected in this room',
          code: 'NO_TV_IN_ROOM'
        });
        return;
      }
      
      if (typeof data.slideIndex !== 'number' || data.slideIndex < 0) {
        socket.emit('error', { 
          message: 'Invalid slide index',
          code: 'INVALID_SLIDE_INDEX'
        });
        return;
      }
      
      logConnection(`Room ${socket.roomId} - Slide change: ${data.slideIndex} from mobile ${socket.id}`);
      
      room.tv.emit('slide_change', {
        slideIndex: data.slideIndex,
        roomId: socket.roomId,
        timestamp: new Date().toISOString(),
        from: socket.id
      });
      
      // Acknowledge to mobile
      socket.emit('slide_change_ack', {
        slideIndex: data.slideIndex,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      logConnection(`Slide change error: ${error.message}`);
      socket.emit('error', { 
        message: 'Failed to change slide',
        code: 'SLIDE_CHANGE_ERROR',
        details: error.message
      });
    }
  });

  // Handle PDF scroll from mobile
  socket.on('pdf_scroll', (data) => {
    try {
      if (socket.deviceType !== 'mobile' || !socket.roomId) {
        socket.emit('error', { 
          message: 'Unauthorized: Only mobile devices in a room can scroll PDF',
          code: 'UNAUTHORIZED_PDF_SCROLL'
        });
        return;
      }
      
      const room = rooms.get(socket.roomId);
      if (!room?.tv?.connected) {
        socket.emit('error', { 
          message: 'TV not connected in this room',
          code: 'NO_TV_IN_ROOM'
        });
        return;
      }
      
      if (typeof data.scrollOffset !== 'number') {
        socket.emit('error', { 
          message: 'Invalid scroll offset',
          code: 'INVALID_SCROLL_OFFSET'
        });
        return;
      }
      
      logConnection(`Room ${socket.roomId} - PDF scroll: offset ${data.scrollOffset}, page ${data.pageNumber || 'unknown'}`);
      
      room.tv.emit('pdf_scroll', {
        scrollOffset: data.scrollOffset,
        pageNumber: data.pageNumber || 1,
        roomId: socket.roomId,
        timestamp: new Date().toISOString(),
        from: socket.id
      });
      
    } catch (error) {
      logConnection(`PDF scroll error: ${error.message}`);
      socket.emit('error', { 
        message: 'Failed to scroll PDF',
        code: 'PDF_SCROLL_ERROR',
        details: error.message
      });
    }
  });

  // Handle PDF page change from mobile
  socket.on('pdf_page_change', (data) => {
    try {
      if (socket.deviceType !== 'mobile' || !socket.roomId) {
        socket.emit('error', { 
          message: 'Unauthorized: Only mobile devices in a room can change PDF pages',
          code: 'UNAUTHORIZED_PDF_PAGE_CHANGE'
        });
        return;
      }
      
      const room = rooms.get(socket.roomId);
      if (!room?.tv?.connected) {
        socket.emit('error', { 
          message: 'TV not connected in this room',
          code: 'NO_TV_IN_ROOM'
        });
        return;
      }
      
      if (typeof data.pageNumber !== 'number' || data.pageNumber < 1) {
        socket.emit('error', { 
          message: 'Invalid page number',
          code: 'INVALID_PAGE_NUMBER'
        });
        return;
      }
      
      logConnection(`Room ${socket.roomId} - PDF page change: ${data.pageNumber}`);
      
      room.tv.emit('pdf_page_change', {
        pageNumber: data.pageNumber,
        roomId: socket.roomId,
        timestamp: new Date().toISOString(),
        from: socket.id
      });
      
    } catch (error) {
      logConnection(`PDF page change error: ${error.message}`);
      socket.emit('error', { 
        message: 'Failed to change PDF page',
        code: 'PDF_PAGE_CHANGE_ERROR',
        details: error.message
      });
    }
  });

  // Handle presentation actions from mobile
  socket.on('presentation_action', (data) => {
    try {
      if (socket.deviceType !== 'mobile' || !socket.roomId) {
        socket.emit('error', { 
          message: 'Unauthorized: Only mobile devices in a room can send presentation actions',
          code: 'UNAUTHORIZED_PRESENTATION_ACTION'
        });
        return;
      }
      
      const room = rooms.get(socket.roomId);
      if (!room?.tv?.connected) {
        socket.emit('error', { 
          message: 'TV not connected in this room',
          code: 'NO_TV_IN_ROOM'
        });
        return;
      }
      
      if (!data.action) {
        socket.emit('error', { 
          message: 'Action is required',
          code: 'MISSING_ACTION'
        });
        return;
      }
      
      logConnection(`Room ${socket.roomId} - Presentation action: ${data.action} with params: ${JSON.stringify(data.params || {})}`);
      
      room.tv.emit('presentation_action', {
        action: data.action,
        params: data.params || {},
        roomId: socket.roomId,
        timestamp: new Date().toISOString(),
        from: socket.id
      });
      
    } catch (error) {
      logConnection(`Presentation action error: ${error.message}`);
      socket.emit('error', { 
        message: 'Failed to execute presentation action',
        code: 'PRESENTATION_ACTION_ERROR',
        details: error.message
      });
    }
  });

  // Handle document/media loading
  socket.on('load_document', (data) => {
    try {
      if (socket.deviceType !== 'mobile' || !socket.roomId) {
        socket.emit('error', { 
          message: 'Unauthorized: Only mobile devices in a room can load documents',
          code: 'UNAUTHORIZED_LOAD_DOCUMENT'
        });
        return;
      }
      
      const room = rooms.get(socket.roomId);
      if (!room?.tv?.connected) {
        socket.emit('error', { 
          message: 'TV not connected in this room',
          code: 'NO_TV_IN_ROOM'
        });
        return;
      }
      
      if (!data.documentType || !data.documentUrl) {
        socket.emit('error', { 
          message: 'Document type and URL are required',
          code: 'MISSING_DOCUMENT_INFO'
        });
        return;
      }
      
      logConnection(`Room ${socket.roomId} - Load document: ${data.documentType} - ${data.documentUrl}`);
      
      room.tv.emit('load_document', {
        documentType: data.documentType,
        documentUrl: data.documentUrl,
        metadata: data.metadata || {},
        roomId: socket.roomId,
        timestamp: new Date().toISOString(),
        from: socket.id
      });
      
    } catch (error) {
      logConnection(`Load document error: ${error.message}`);
      socket.emit('error', { 
        message: 'Failed to load document',
        code: 'LOAD_DOCUMENT_ERROR',
        details: error.message
      });
    }
  });

  // Handle custom events
  socket.on('custom_event', (data) => {
    try {
      if (!socket.roomId) {
        socket.emit('error', { 
          message: 'Not in a room',
          code: 'NO_ROOM'
        });
        return;
      }
      
      const room = rooms.get(socket.roomId);
      if (!room) {
        socket.emit('error', { 
          message: 'Room not found',
          code: 'ROOM_NOT_FOUND'
        });
        return;
      }
      
      logConnection(`Room ${socket.roomId} - Custom event: ${data.eventType || 'unknown'} from ${socket.deviceType}`);
      
      // Forward to the other device in the room
      const targetDevice = socket.deviceType === 'mobile' ? room.tv : room.mobile;
      if (targetDevice && targetDevice.connected) {
        targetDevice.emit('custom_event', {
          ...data,
          roomId: socket.roomId,
          timestamp: new Date().toISOString(),
          from: socket.id,
          fromDevice: socket.deviceType
        });
      } else {
        socket.emit('error', { 
          message: `${socket.deviceType === 'mobile' ? 'TV' : 'Mobile'} not connected in this room`,
          code: 'TARGET_DEVICE_NOT_CONNECTED'
        });
      }
      
    } catch (error) {
      logConnection(`Custom event error: ${error.message}`);
      socket.emit('error', { 
        message: 'Failed to send custom event',
        code: 'CUSTOM_EVENT_ERROR',
        details: error.message
      });
    }
  });

  // Handle ping for connection health monitoring
  socket.on('ping', (data) => {
    socket.isHealthy = true;
    socket.lastPing = new Date();
    socket.emit('pong', { 
      timestamp: new Date().toISOString(),
      clientId: socket.id
    });
  });

  // Handle pong responses
  socket.on('pong', (data) => {
    socket.isHealthy = true;
    socket.lastPong = new Date();
  });

  // Handle connection test
  socket.on('connection_test', (data) => {
    socket.emit('connection_test_response', {
      received: data,
      timestamp: new Date().toISOString(),
      serverId: socket.id,
      status: 'connected'
    });
  });

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    stats.currentConnections = Math.max(0, stats.currentConnections - 1);
    
    logConnection(`Client disconnected: ${socket.id} - Device: ${socket.deviceType || 'unknown'} - Room: ${socket.roomId || 'none'} - Reason: ${reason}`);
    
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      
      if (socket.deviceType === 'tv' && room.tv?.id === socket.id) {
        room.tv = null;
        stats.tvConnections = Math.max(0, stats.tvConnections - 1);
        
        // Notify mobile about TV disconnection
        if (room.mobile && room.mobile.connected) {
          room.mobile.emit('tv_disconnected', { 
            status: 'disconnected',
            deviceId: socket.id,
            reason: reason,
            timestamp: new Date().toISOString()
          });
        }
        
        logConnection(`TV disconnected from room ${socket.roomId}`);
        
      } else if (socket.deviceType === 'mobile' && room.mobile?.id === socket.id) {
        room.mobile = null;
        stats.mobileConnections = Math.max(0, stats.mobileConnections - 1);
        
        // Notify TV about mobile disconnection
        if (room.tv && room.tv.connected) {
          room.tv.emit('mobile_disconnected', { 
            status: 'disconnected',
            deviceId: socket.id,
            reason: reason,
            timestamp: new Date().toISOString()
          });
        }
        
        logConnection(`Mobile disconnected from room ${socket.roomId}`);
      }
      
      // Clean up empty rooms
      if ((!room.tv || !room.tv.connected) && (!room.mobile || !room.mobile.connected)) {
        cleanupRoom(socket.roomId, 'all_devices_disconnected');
      }
    }
  });

  // Handle socket errors
  socket.on('error', (error) => {
    logConnection(`Socket error for ${socket.id}: ${error.message || error}`);
    socket.emit('error_ack', {
      message: 'Socket error received',
      timestamp: new Date().toISOString()
    });
  });

  // Send welcome message
  socket.emit('connected', {
    message: 'Connected to Flutter Presentation Server',
    clientId: socket.id,
    serverVersion: '2.2.0',
    timestamp: new Date().toISOString()
  });
});

// Health monitoring - ping clients every 30 seconds
setInterval(() => {
  const now = new Date();
  let healthyConnections = 0;
  
  for (const [roomId, room] of rooms.entries()) {
    if (room.mobile && room.mobile.connected) {
      room.mobile.emit('ping', { 
        timestamp: now.toISOString(),
        type: 'health_check'
      });
      if (room.mobile.isHealthy) healthyConnections++;
    }
    if (room.tv && room.tv.connected) {
      room.tv.emit('ping', { 
        timestamp: now.toISOString(),
        type: 'health_check'
      });
      if (room.tv.isHealthy) healthyConnections++;
    }
  }
  
  logConnection(`Health check sent to ${healthyConnections} healthy connections`);
}, 30000);

// Cleanup unhealthy connections every 2 minutes
setInterval(() => {
  const now = new Date();
  const timeout = 120000; // 2 minutes timeout
  
  for (const [roomId, room] of rooms.entries()) {
    let roomNeedsCleanup = false;
    
    // Check mobile health
    if (room.mobile) {
      const isUnhealthy = !room.mobile.connected || 
                         (room.mobile.lastPong && (now - room.mobile.lastPong) > timeout);
      
      if (isUnhealthy) {
        logConnection(`Mobile client ${room.mobile.id} in room ${roomId} is unhealthy, removing...`);
        if (room.mobile.connected) {
          room.mobile.emit('connection_timeout', { message: 'Connection timed out' });
          room.mobile.disconnect(true);
        }
        room.mobile = null;
        stats.mobileConnections = Math.max(0, stats.mobileConnections - 1);
        roomNeedsCleanup = !room.tv || !room.tv.connected;
      }
    }
    
    // Check TV health
    if (room.tv) {
      const isUnhealthy = !room.tv.connected || 
                         (room.tv.lastPong && (now - room.tv.lastPong) > timeout);
      
      if (isUnhealthy) {
        logConnection(`TV client ${room.tv.id} in room ${roomId} is unhealthy, removing...`);
        if (room.tv.connected) {
          room.tv.emit('connection_timeout', { message: 'Connection timed out' });
          room.tv.disconnect(true);
        }
        room.tv = null;
        stats.tvConnections = Math.max(0, stats.tvConnections - 1);
        roomNeedsCleanup = roomNeedsCleanup || !room.mobile || !room.mobile.connected;
      }
    }
    
    // Clean up empty or unhealthy rooms
    if (roomNeedsCleanup) {
      cleanupRoom(roomId, 'unhealthy_connections');
    }
  }
}, 120000);

// Periodic room cleanup - remove old empty rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  const roomsToCleanup = [];
  
  for (const [roomId, room] of rooms.entries()) {
    const roomAge = now - room.createdAt.getTime();
    const isEmpty = (!room.tv || !room.tv.connected) && (!room.mobile || !room.mobile.connected);
    const isExpired = roomAge > ROOM_TIMEOUT;
    
    if (isEmpty && isExpired) {
      roomsToCleanup.push(roomId);
    }
  }
  
  roomsToCleanup.forEach(roomId => {
    cleanupRoom(roomId, 'expired');
  });
  
  if (roomsToCleanup.length > 0) {
    logConnection(`Cleaned up ${roomsToCleanup.length} expired rooms`);
  }
}, 300000); // Every 5 minutes

// Log server statistics every 10 minutes
setInterval(() => {
  const status = getConnectionStatus();
  logConnection(`Server Statistics - Connections: ${stats.currentConnections}, Active Rooms: ${status.totalRooms}, TVs: ${status.connectedTVs}, Mobiles: ${status.connectedMobiles}`);
}, 600000);

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  logConnection(`${signal} received, initiating graceful shutdown...`);
  
  // Notify all connected clients about server shutdown
  for (const [roomId, room] of rooms.entries()) {
    if (room.tv && room.tv.connected) {
      room.tv.emit('server_shutdown', { 
        message: 'Server is shutting down for maintenance',
        timestamp: new Date().toISOString()
      });
    }
    if (room.mobile && room.mobile.connected) {
      room.mobile.emit('server_shutdown', { 
        message: 'Server is shutting down for maintenance',
        timestamp: new Date().toISOString()
      });
    }
  }
  
  // Close server gracefully
  io.close(() => {
    logConnection('Socket.IO server closed');
    server.close(() => {
      logConnection('HTTP server closed');
      process.exit(0);
    });
  });
  
  // Force close after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    logConnection('Force closing server after timeout');
    process.exit(1);
  }, 10000);
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logConnection(`Uncaught Exception: ${error.message}`);
  console.error(error.stack);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  logConnection(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
  console.error(reason);
});

// Start server
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  logConnection(`Flutter Socket.IO Presentation Server v2.2.0 running on ${HOST}:${PORT}`);
  logConnection(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logConnection(`Health check: http://${HOST}:${PORT}/health`);
  logConnection(`API status: http://${HOST}:${PORT}/api/status`);
  logConnection(`CORS enabled for: ${process.env.CORS_ORIGIN || '*'}`);
  logConnection(`Room timeout: ${ROOM_TIMEOUT / 1000 / 60} minutes`);
});

// Export for testing
module.exports = { 
  app, 
  server, 
  io, 
  rooms, 
  stats, 
  getRoomInfo, 
  getConnectionStatus,
  cleanupRoom
};