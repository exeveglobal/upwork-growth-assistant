// config.js - Build-time constants. Nothing here is secret: this extension is public source.

// Exeve growth engine. Members connect with a key issued by the Exeve admin.
export const DEFAULT_ENGINE_URL = 'https://ege.exeve.global';

// Version of the tracking notice shown before connecting (sidepanel.html #consent-box).
// Bump it whenever that text changes; the engine records which version each device accepted.
export const CONSENT_VERSION = 1;
