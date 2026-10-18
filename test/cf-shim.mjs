// Testler için "cloudflare:workers" modülünün basit taklidi.
export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
