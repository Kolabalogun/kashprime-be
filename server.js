require('dotenv').config();

// Polyfill Web API globals (fetch, Headers, Request, Response) for Node.js environments
if (!globalThis.fetch || !globalThis.Headers) {
  const undici = require('undici');
  if (!globalThis.fetch) globalThis.fetch = undici.fetch;
  if (!globalThis.Headers) globalThis.Headers = undici.Headers;
  if (!globalThis.Request) globalThis.Request = undici.Request;
  if (!globalThis.Response) globalThis.Response = undici.Response;
}

const express = require('express');
const app = require('./src/app');

   
                    

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`  Server running on port ${PORT}`);
  console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 API Base URL: http://localhost:${PORT}/api`);
  console.log(`🏥 Health Check: http://localhost:${PORT}/health`);
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Process terminated');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Process terminated');
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
  console.log('Unhandled Promise Rejection:', err.message);
  server.close(() => {
    process.exit(1);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.log('Uncaught Exception:', err.message);
  server.close(() => {
    process.exit(1);
  });
});

module.exports = server;
