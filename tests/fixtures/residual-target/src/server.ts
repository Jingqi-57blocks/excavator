import { Hono } from "hono";
const app = new Hono().basePath("/api");
function listLeave(c: unknown) { return { requests: [] }; }
app.get("/leave", listLeave);
export default app;
