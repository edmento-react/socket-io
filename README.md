# Socket.IO Presentation Server

A real-time Socket.IO server for controlling presentations between mobile devices and TV/display screens. This server enables seamless communication for presentation control, PDF navigation, slide changes, and media loading.

## Features

- **Real-time Communication**: WebSocket-based communication between mobile and TV clients
- **Device Management**: Automatic client registration and connection management
- **Presentation Control**: Slide navigation, PDF scrolling, and media control
- **Health Monitoring**: Built-in health checks and connection monitoring
- **Error Handling**: Comprehensive error handling with detailed error codes
- **Rate Limiting**: Protection against spam and abuse
- **Security**: CORS protection and input validation

## Quick Start

### Installation

```bash
# Install dependencies
npm install

# Copy environment configuration
cp .env.example .env

# Start the server
npm start

# For development with auto-reload
npm run dev
```

### Basic Usage

1. Start the server: `npm start`
2. Server runs on `http://localhost:8080`
3. Connect mobile and TV clients using Socket.IO
4. Register devices and start controlling presentations

## API Documentation

### REST Endpoints

#### GET /
**Health check and basic server information**

```bash
curl http://localhost:8080/
```

**Response (200 OK):**
```json
{
  "status": "Socket.IO Presentation Server Running",
  "version": "1.0.0",
  "uptime": 3600,
  "clients": ["mobile", "tv"],
  "stats": {
    "currentConnections": 2,
    "totalConnections": 15
  }
}
```

#### GET /api/status
**Detailed server status and statistics**

```bash
curl http://localhost:8080/api/status
```

**Response (200 OK):**
```json
{
  "server": {
    "status": "running",
    "uptime": 3600,
    "startTime": "2025-01-07T07:00:00.000Z"
  },
  "connections": {
    "mobile": "connected",
    "tv": "connected"
  },
  "statistics": {
    "totalConnections": 15,
    "currentConnections": 2,
    "mobileConnections": 1,
    "tvConnections": 1,
    "startTime": "2025-01-07T07:00:00.000Z"
  }
}
```

#### GET /api/clients
**Information about connected clients**

```bash
curl http://localhost:8080/api/clients
```

**Response (200 OK):**
```json
{
  "clients": {
    "mobile": {
      "id": "socket_id_123",
      "connected": true,
      "connectedAt": "2025-01-07T07:30:00.000Z"
    },
    "tv": {
      "id": "socket_id_456",
      "connected": true,
      "connectedAt": "2025-01-07T07:25:00.000Z"
    }
  },
  "summary": {
    "mobile": "connected",
    "tv": "connected"
  }
}
```

#### GET /health
**Simple health check endpoint**

```bash
curl http://localhost:8080/health
```

**Response (200 OK):**
```json
{
  "status": "healthy",
  "timestamp": "2025-01-07T07:30:00.000Z"
}
```

### Socket.IO Events

#### Client Registration

**Event: `register`**
Register a device as mobile or TV client.

```javascript
// Mobile client registration
socket.emit('register', {
  deviceType: 'mobile'
});

// TV client registration
socket.emit('register', {
  deviceType: 'tv'
});
```

**Response: `registered`**
```javascript
socket.on('registered', (data) => {
  console.log(data);
  // {
  //   deviceType: 'mobile',
  //   clientId: 'socket_id_123',
  //   connectedDevices: {
  //     mobile: 'connected',
  //     tv: 'connected'
  //   },
  //   timestamp: '2025-01-07T07:30:00.000Z'
  // }
});
```

**Error Response: `error`**
```javascript
socket.on('error', (error) => {
  console.error(error);
  // {
  //   message: 'Invalid device type. Must be "mobile" or "tv"',
  //   code: 'INVALID_DEVICE_TYPE'
  // }
});
```

#### Presentation Control

**Event: `slide_change`** (Mobile → TV)
Change presentation slide.

```javascript
// From mobile client
socket.emit('slide_change', {
  slideIndex: 5,
  totalSlides: 20,
  direction: 'next' // 'next', 'previous', 'jump'
});
```

**Event: `pdf_scroll`** (Mobile → TV)
Scroll PDF document.

```javascript
// From mobile client
socket.emit('pdf_scroll', {
  scrollOffset: 150,
  pageNumber: 3,
  direction: 'down' // 'up', 'down'
});
```

**Event: `pdf_page_change`** (Mobile → TV)
Change PDF page.

```javascript
// From mobile client
socket.emit('pdf_page_change', {
  pageNumber: 5,
  totalPages: 25
});
```

**Event: `presentation_action`** (Mobile → TV)
Control presentation playback.

```javascript
// From mobile client
socket.emit('presentation_action', {
  action: 'play', // 'play', 'pause', 'stop', 'next', 'previous', 'fullscreen', 'exit_fullscreen'
  timestamp: Date.now()
});
```

**Event: `load_document`** (Mobile → TV)
Load a new document or media.

```javascript
// From mobile client
socket.emit('load_document', {
  documentType: 'pdf', // 'pdf', 'powerpoint', 'image', 'video'
  documentUrl: 'https://example.com/presentation.pdf',
  documentName: 'My Presentation',
  metadata: {
    totalPages: 25,
    duration: 1800 // for videos
  }
});
```

#### Connection Status Events

**Event: `mobile_connected`** (Server → TV)
Notifies TV when mobile connects.

```javascript
socket.on('mobile_connected', (data) => {
  console.log('Mobile device connected:', data);
  // {
  //   status: 'connected',
  //   clientId: 'mobile_socket_id',
  //   timestamp: '2025-01-07T07:30:00.000Z'
  // }
});
```

**Event: `tv_connected`** (Server → Mobile)
Notifies mobile when TV connects.

```javascript
socket.on('tv_connected', (data) => {
  console.log('TV connected:', data);
  // {
  //   status: 'connected',
  //   clientId: 'tv_socket_id',
  //   timestamp: '2025-01-07T07:30:00.000Z'
  // }
});
```

#### Health Monitoring

**Event: `ping`** (Server → Client)
Server health check ping.

```javascript
socket.on('ping', (data) => {
  console.log('Ping received:', data.timestamp);
  // Respond with pong
  socket.emit('pong');
});
```

**Event: `pong`** (Client → Server)
Client health check response.

```javascript
socket.emit('pong');
```

#### Custom Events

**Event: `custom_event`** (Mobile → TV)
Send custom events for extended functionality.

```javascript
// From mobile client
socket.emit('custom_event', {
  eventType: 'annotation_added',
  data: {
    x: 100,
    y: 200,
    text: 'Important note',
    color: '#ff0000'
  }
});
```

## Error Codes

| Code | Description |
|------|-------------|
| `INVALID_DEVICE_TYPE` | Device type must be 'mobile' or 'tv' |
| `REGISTRATION_ERROR` | Failed to register device |
| `UNAUTHORIZED_OR_NO_TV` | Mobile client unauthorized or TV not connected |
| `INVALID_SLIDE_DATA` | Invalid slide change data |
| `INVALID_SCROLL_DATA` | Invalid PDF scroll data |
| `INVALID_PAGE_DATA` | Invalid PDF page data |
| `INVALID_ACTION` | Invalid presentation action |
| `INVALID_DOCUMENT_DATA` | Invalid document loading data |
| `INVALID_CUSTOM_EVENT` | Invalid custom event data |

## Testing the API

### Using curl for REST endpoints

```bash
# Check server status
curl -X GET http://localhost:8080/

# Get detailed status
curl -X GET http://localhost:8080/api/status

# Check connected clients
curl -X GET http://localhost:8080/api/clients

# Health check
curl -X GET http://localhost:8080/health
```

### Using Node.js for Socket.IO testing

```javascript
const io = require('socket.io-client');

// Connect to server
const socket = io('http://localhost:8080');

// Register as mobile
socket.emit('register', { deviceType: 'mobile' });

// Listen for registration confirmation
socket.on('registered', (data) => {
    console.log('Registered:', data);
    
    // Test slide change
    socket.emit('slide_change', {
        slideIndex: 1,
        direction: 'next'
    });
});

// Handle errors
socket.on('error', (error) => {
    console.error('Error:', error);
});
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Server Configuration
PORT=8080
NODE_ENV=development

# CORS Configuration
CORS_ORIGIN=*

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Health Check Configuration
PING_INTERVAL=30000
CLIENT_TIMEOUT=60000
```

## Development

```bash
# Install dependencies
npm install

# Start development server with auto-reload
npm run dev
```

## Production Deployment

1. Set environment variables
2. Install production dependencies: `npm ci --production`
3. Start server: `npm start`
4. Use process manager like PM2 for production

```bash
# Using PM2
npm install -g pm2
pm2 start server.js --name "presentation-server"
```

## License

MIT License
