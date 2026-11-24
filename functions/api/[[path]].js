// Cloudflare Pages entry point. All the logic is in ../_lib/app.js.
import { handle } from "../_lib/app.js";

export const onRequest = ({ request, env }) => handle(request, env);
