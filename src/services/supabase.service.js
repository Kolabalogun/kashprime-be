// Polyfill Web API globals (fetch, Headers, Request, Response) for Node.js environments
if (!globalThis.fetch || !globalThis.Headers) {
  const undici = require('undici');
  if (!globalThis.fetch) globalThis.fetch = undici.fetch;
  if (!globalThis.Headers) globalThis.Headers = undici.Headers;
  if (!globalThis.Request) globalThis.Request = undici.Request;
  if (!globalThis.Response) globalThis.Response = undici.Response;
}

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

// Service role client for admin operations
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

// Regular client for user operations
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

module.exports = {
  supabase,
  supabaseAdmin
};