import { createClient } from "@supabase/supabase-js";

export const OPEN_ELECTRICITY_DATA_TABLE = "open_electricity_data";

class DisabledRealtimeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor() {
    this.readyState = DisabledRealtimeWebSocket.CLOSED;
    this.url = "disabled://supabase-realtime";
    this.protocol = "";
    this.extensions = "";
    this.binaryType = "arraybuffer";
    this.bufferedAmount = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  addEventListener() {}

  removeEventListener() {}

  send() {
    throw new Error(
      "Supabase realtime transport is disabled for this server-side admin client.",
    );
  }

  close() {}
}

function getRealtimeOptions() {
  if (typeof WebSocket !== "undefined") {
    return {};
  }

  return {
    transport: DisabledRealtimeWebSocket,
  };
}

export function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL.");
  }

  if (!serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY. Server-side Open Electricity storage now writes through Supabase and requires the service role key.",
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    realtime: getRealtimeOptions(),
  });
}
