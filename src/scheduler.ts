export type ScheduleInput = {
  userId: string;
  providerId: string;
  accountId: string;
  runAt: number;
};

export interface AuthEventPublisher {
  scheduleRefresh(input: ScheduleInput): Promise<void>;
}

export class NoopPublisher implements AuthEventPublisher {
  async scheduleRefresh(_input: ScheduleInput): Promise<void> {
    return;
  }
}

function hmacSha256(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(secret);
  const payloadBytes = encoder.encode(payload);
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  ).then(key => crypto.subtle.sign('HMAC', key, payloadBytes))
   .then(sig => {
     const bytes = new Uint8Array(sig);
     let bin = '';
     for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
     return btoa(bin);
   });
}

export class InngestPublisher implements AuthEventPublisher {
  constructor(private baseUrl: string, private signingKey: string) {}

  async scheduleRefresh(input: ScheduleInput): Promise<void> {
    const body = JSON.stringify({
      name: 'auth/schedule',
      data: input,
      ts: Date.now()
    });

    const signature = await hmacSha256(this.signingKey, body);

    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature
      },
      body
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Inngest publish failed: ${res.status} ${text}`);
    }
  }
}


