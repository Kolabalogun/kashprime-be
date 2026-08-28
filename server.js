require('dotenv').config({ override: true });

// Polyfill Web API globals (fetch, Headers, Request, Response) for Node.js environments
if (!globalThis.fetch || !globalThis.Headers) {
  const fetch = require('node-fetch');
  if (!globalThis.fetch) globalThis.fetch = fetch;
  if (!globalThis.Headers) globalThis.Headers = fetch.Headers;
  if (!globalThis.Request) globalThis.Request = fetch.Request;
  if (!globalThis.Response) globalThis.Response = fetch.Response;
}

const express = require('express');
const app = require('./src/app');




const { autoProcessDuePayouts } = require('./src/controllers/investment.controller');

const PORT = process.env.PORT || 8082;

const server = app.listen(PORT, () => {
  console.log(`  Server running on port ${PORT}`);
  console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 API Base URL: http://localhost:${PORT}/api`);
  console.log(`🏥 Health Check: http://localhost:${PORT}/health`);

  // Run autoProcessDuePayouts initial check + periodic interval (every 2 minutes)
  autoProcessDuePayouts().catch(err => console.error('Initial payout job error:', err));
  setInterval(() => {
    autoProcessDuePayouts().catch(err => console.error('Background payout job error:', err));
  }, 120 * 1000);
});   

// Gracefull shutdown handling
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
