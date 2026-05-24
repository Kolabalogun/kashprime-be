// Polyfill Web API globals (fetch, Headers, Request, Response) for Node.js environments
if (!globalThis.fetch || !globalThis.Headers) {
  const fetch = require('node-fetch');
  if (!globalThis.fetch) globalThis.fetch = fetch;
  if (!globalThis.Headers) globalThis.Headers = fetch.Headers;
  if (!globalThis.Request) globalThis.Request = fetch.Request;
  if (!globalThis.Response) globalThis.Response = fetch.Response;
}

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ override: true });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

const requiredEnv = {
  SUPABASE_URL: supabaseUrl,
  SUPABASE_SERVICE_KEY: supabaseServiceKey,
  SUPABASE_ANON_KEY: supabaseAnonKey,
};

const missingEnv = Object.entries(requiredEnv)
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missingEnv.length > 0) {
  throw new Error(
    `Missing required Supabase environment variable(s): ${missingEnv.join(', ')}. ` +
      'Set these in your production hosting environment before starting the backend.'
  );
}

// Service role client for admin operations
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

// Regular client for user operations
const supabase = createClient(supabaseUrl, supabaseAnonKey);

module.exports = {
  supabase,
  supabaseAdmin
};
