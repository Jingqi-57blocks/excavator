import { Hono } from "hono";
const app = new Hono().basePath("/api");
function requireManager(c: unknown, next: () => Promise<void>) { return next(); }
function listLeave(c: unknown) { return { requests: [] }; }
app.get("/leave", requireManager, listLeave);
export default app;
