import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Logger class for structured logging
export class Logger {
  constructor(filename) {
    this.filename = path.join(logsDir, filename);
    this.initializeLogFile();
  }

  initializeLogFile() {
    if (!fs.existsSync(this.filename)) {
      fs.writeFileSync(this.filename, '');
    }
  }

  log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      ...data
    };
    
    const logLine = JSON.stringify(logEntry) + '\n';
    fs.appendFileSync(this.filename, logLine);
    
    // Also log to console for development
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[${level}] ${message}`, data);
    }
  }

  info(message, data) {
    this.log('INFO', message, data);
  }

  error(message, data) {
    this.log('ERROR', message, data);
  }

  warn(message, data) {
    this.log('WARN', message, data);
  }

  debug(message, data) {
    this.log('DEBUG', message, data);
  }
}

// Create logger instances
export const appLogger = new Logger('app.log');
export const apiLogger = new Logger('api.log');
export const errorLogger = new Logger('error.log');
export const authLogger = new Logger('auth.log');

// Monitoring metrics
export class Metrics {
  constructor() {
    this.requests = 0;
    this.errors = 0;
    this.startTime = Date.now();
    this.endpoints = {};
  }

  recordRequest(endpoint, method, statusCode, duration) {
    this.requests++;
    
    if (!this.endpoints[endpoint]) {
      this.endpoints[endpoint] = {
        count: 0,
        avgDuration: 0,
        errors: 0,
        lastAccessed: null
      };
    }

    const ep = this.endpoints[endpoint];
    ep.count++;
    ep.avgDuration = (ep.avgDuration + duration) / 2;
    ep.lastAccessed = new Date().toISOString();

    if (statusCode >= 400) {
      this.errors++;
      ep.errors++;
    }

    apiLogger.info('API Request', {
      endpoint,
      method,
      statusCode,
      duration: `${duration}ms`
    });
  }

  getMetrics() {
    const uptime = Date.now() - this.startTime;
    return {
      uptime: `${Math.floor(uptime / 1000)}s`,
      totalRequests: this.requests,
      totalErrors: this.errors,
      errorRate: ((this.errors / this.requests) * 100).toFixed(2) + '%',
      endpoints: this.endpoints
    };
  }

  logMetrics() {
    const metrics = this.getMetrics();
    appLogger.info('System Metrics', metrics);
    return metrics;
  }
}

export const metrics = new Metrics();

// Health check function
export function getHealthStatus() {
  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - metrics.startTime) / 1000),
    metrics: metrics.getMetrics()
  };
}

// Middleware for request logging
export function requestLoggingMiddleware(req, res, next) {
  const startTime = Date.now();
  
  // Log incoming request
  apiLogger.info('Incoming Request', {
    method: req.method,
    path: req.path,
    ip: req.ip
  });

  // Intercept response
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - startTime;
    metrics.recordRequest(req.path, req.method, res.statusCode, duration);
    
    return originalSend.call(this, data);
  };

  next();
}

// Error logging middleware
export function errorLoggingMiddleware(err, req, res, next) {
  errorLogger.error('Application Error', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });

  res.status(500).json({
    error: 'Internal Server Error',
    requestId: req.id
  });
}
