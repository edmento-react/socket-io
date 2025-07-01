require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"]
  }
});

// Store connected clients
const clients = {
  mobile: null,
  tv: null
};

// Connection statistics
const stats = {
  totalConnections: 0,
  currentConnections: 0,
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

const validateDeviceType = (deviceType) => {
  return ['mobile', 'tv'].includes(deviceType);
};

const getConnectionStatus = () => {
  return {
    mobile: clients.mobile ? 'connected' : 'disconnected',
    tv: clients.tv ? 'connected' : 'disconnected'
  };
};

// Routes
app.get('/', (req, res) => {
  res.json({ 
    status: 'Socket.IO Presentation Server Running',
    version: '1.0.0',
    uptime: Math.floor((Date.now() - stats.startTime.getTime()) / 1000),
    clients: Object.keys(clients).filter(key => clients[key] !== null),
    stats: {
      currentConnections: stats.currentConnections,
      totalConnections: stats.totalConnections
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
    statistics: stats
  });
});

app.get('/api/clients', (req, res) => {
  const clientInfo = {};
  
  if (clients.mobile) {
    clientInfo.mobile = {
      id: clients.mobile.id,
      connected: true,
      connectedAt: clients.mobile.connectedAt || 'unknown'
    };
  }
  
  if (clients.tv) {
    clientInfo.tv = {
      id: clients.tv.id,
      connected: true,
      connectedAt: clients.tv.connectedAt || 'unknown'
    };
  }
  
  res.json({
    clients: clientInfo,
    summary: getConnectionStatus()
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// POST API: Accept a message and broadcast to TV if connected
app.post('/api/message', (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ status: 'error', error: 'Message is required' });
  }
  logConnection(`Received POST message: ${message}`);
  // Broadcast to TV if connected
  if (clients.tv) {
    clients.tv.emit('message_from_api', {
      message,
      timestamp: new Date().toISOString()
    });
  }
  res.json({ status: 'sent', message });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  stats.totalConnections++;
  stats.currentConnections++;
  socket.connectedAt = new Date().toISOString();
  
  logConnection(`Client connected: ${socket.id}`);

  // Handle client registration
  socket.on('register', (data) => {
    try {
      const { deviceType } = data;
      
      if (!validateDeviceType(deviceType)) {
        socket.emit('error', { 
          message: 'Invalid device type. Must be "mobile" or "tv"',
          code: 'INVALID_DEVICE_TYPE'
        });
        return;
      }
      
      if (deviceType === 'mobile') {
        // Disconnect previous mobile client if exists
        if (clients.mobile && clients.mobile.id !== socket.id) {
          clients.mobile.emit('replaced', { message: 'New mobile client connected' });
          clients.mobile.disconnect();
          stats.mobileConnections--;
        }
        clients.mobile = socket;
        socket.deviceType = 'mobile';
        stats.mobileConnections++;
        logConnection(`Mobile client registered: ${socket.id}`);
        
        // Notify TV about mobile connection
        if (clients.tv) {
          clients.tv.emit('mobile_connected', { 
            status: 'connected',
            clientId: socket.id,
            timestamp: new Date().toISOString()
          });
        }
        
      } else if (deviceType === 'tv') {
        // Disconnect previous TV client if exists
        if (clients.tv && clients.tv.id !== socket.id) {
          clients.tv.emit('replaced', { message: 'New TV client connected' });
          clients.tv.disconnect();
          stats.tvConnections--;
        }
        clients.tv = socket;
        socket.deviceType = 'tv';
        stats.tvConnections++;
        logConnection(`TV client registered: ${socket.id}`);
        
        // Notify mobile about TV connection
        if (clients.mobile) {
          clients.mobile.emit('tv_connected', { 
            status: 'connected',
            clientId: socket.id,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      // Send registration confirmation
      socket.emit('registered', { 
        deviceType: deviceType,
        clientId: socket.id,
        connectedDevices: getConnectionStatus(),
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      logConnection(`Registration error for ${socket.id}: ${error.message}`);
      socket.emit('error', { 
        message: 'Registration failed',
        code: 'REGISTRATION_ERROR'
      });
    }
  });

  // Handle slide changes from mobile
  socket.on('slide_change', (data) => {
    try {
      if (socket.deviceType === 'mobile' && clients.tv) {
        if (typeof data.slideIndex !== 'number') {
          throw new Error('Invalid slide index');
        }
        logConnection(`Slide change: ${data.slideIndex}`);
        clients.tv.emit('slide_change', {
          ...data,
          timestamp: new Date().toISOString(),
          from: socket.id
        });
      } else {
        socket.emit('error', { 
          message: 'Unauthorized or TV not connected',
          code: 'UNAUTHORIZED_OR_NO_TV'
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
      if (socket.deviceType === 'mobile' && clients.tv) {
        if (typeof data.scrollOffset !== 'number') {
          throw new Error('Invalid scroll offset');
        }
        logConnection(`PDF scroll: offset ${data.scrollOffset}, page ${data.pageNumber || 'unknown'}`);
        clients.tv.emit('pdf_scroll', {
          ...data,
          timestamp: new Date().toISOString(),
          from: socket.id
        });
      } else {
        socket.emit('error', { 
          message: 'Unauthorized or TV not connected',
          code: 'UNAUTHORIZED_OR_NO_TV'
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
      if (socket.deviceType === 'mobile' && clients.tv) {
        if (typeof data.pageNumber !== 'number') {
          throw new Error('Invalid page number');
        }
        logConnection(`PDF page change: ${data.pageNumber}`);
        clients.tv.emit('pdf_page_change', {
          ...data,
          timestamp: new Date().toISOString(),
          from: socket.id
        });
      } else {
        socket.emit('error', { 
          message: 'Unauthorized or TV not connected',
          code: 'UNAUTHORIZED_OR_NO_TV'
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
      if (socket.deviceType === 'mobile' && clients.tv) {
        const validActions = ['play', 'pause', 'stop', 'next', 'previous', 'fullscreen', 'exit_fullscreen'];
        if (!validActions.includes(data.action)) {
          throw new Error('Invalid action');
        }
        logConnection(`Presentation action: ${data.action}`);
        clients.tv.emit('presentation_action', {
          ...data,
          timestamp: new Date().toISOString(),
          from: socket.id
        });
      } else {
        socket.emit('error', { 
          message: 'Unauthorized or TV not connected',
          code: 'UNAUTHORIZED_OR_NO_TV'
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
      if (socket.deviceType === 'mobile' && clients.tv) {
        const validTypes = ['pdf', 'powerpoint', 'image', 'video'];
        if (!validTypes.includes(data.documentType)) {
          throw new Error('Invalid document type');
        }
        logConnection(`Load document: ${data.documentType} - ${data.documentUrl || data.documentName || 'unknown'}`);
        clients.tv.emit('load_document', {
          ...data,
          timestamp: new Date().toISOString(),
          from: socket.id
        });
      } else {
        socket.emit('error', { 
          message: 'Unauthorized or TV not connected',
          code: 'UNAUTHORIZED_OR_NO_TV'
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
      if (socket.deviceType === 'mobile' && clients.tv) {
        logConnection(`Custom event: ${data.eventType || 'unknown'}`);
        clients.tv.emit('custom_event', {
          ...data,
          timestamp: new Date().toISOString(),
          from: socket.id
        });
      } else {
        socket.emit('error', { 
          message: 'Unauthorized or TV not connected',
          code: 'UNAUTHORIZED_OR_NO_TV'
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
    
    if (socket.deviceType === 'mobile') {
      clients.mobile = null;
      stats.mobileConnections--;
      // Notify TV about mobile disconnection
      if (clients.tv) {
        clients.tv.emit('mobile_disconnected', { 
          status: 'disconnected',
          reason: reason,
          timestamp: new Date().toISOString()
        });
      }
    } else if (socket.deviceType === 'tv') {
      clients.tv = null;
      stats.tvConnections--;
      // Notify mobile about TV disconnection
      if (clients.mobile) {
        clients.mobile.emit('tv_disconnected', { 
          status: 'disconnected',
          reason: reason,
          timestamp: new Date().toISOString()
        });
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
  
  if (clients.mobile) {
    clients.mobile.emit('ping', { timestamp: now.toISOString() });
  }
  if (clients.tv) {
    clients.tv.emit('ping', { timestamp: now.toISOString() });
  }
}, 30000);

// Cleanup disconnected clients every 60 seconds
setInterval(() => {
  const now = new Date();
  const timeout = 60000; // 60 seconds timeout
  
  if (clients.mobile && clients.mobile.lastPong && (now - clients.mobile.lastPong) > timeout) {
    logConnection(`Mobile client ${clients.mobile.id} timed out`);
    clients.mobile.disconnect();
  }
  
  if (clients.tv && clients.tv.lastPong && (now - clients.tv.lastPong) > timeout) {
    logConnection(`TV client ${clients.tv.id} timed out`);
    clients.tv.disconnect();
  }
}, 60000);

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
  logConnection(`Socket.IO Presentation Server running on port ${PORT}`);
  logConnection(`Health check available at http://localhost:${PORT}`);
  logConnection(`API status available at http://localhost:${PORT}/api/status`);
});

module.exports = { app, server, io };