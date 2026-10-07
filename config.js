// config.js - Build-time constants. Nothing here is secret: this extension is public source.

// Exeve growth engine. Members connect with a key issued by the account admin.
export const DEFAULT_ENGINE_URL = 'https://ege.exeve.global';

// Version of the tracking notice shown before connecting (sidepanel.html #consent-box).
// Bump it whenever that text changes; the engine records which version each device accepted.
// 2: states that pages are only read while the member has them open, and adds the proposals check-in time
export const CONSENT_VERSION = 2;
