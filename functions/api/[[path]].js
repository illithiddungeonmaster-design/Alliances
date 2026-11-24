import { handle } from '../../src/api.js';

// One catch-all Pages Function handles every /api/* request.
export const onRequest = (context) => handle(context.request, context.env);
