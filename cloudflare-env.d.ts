declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    APP_ENCRYPTION_KEY?: string;
    KEXU_LOCAL_MODE?: string;
    KEXU_MODEL_BRIDGE_URL?: string;
    KEXU_MODEL_BRIDGE_TOKEN?: string;
  }
}
