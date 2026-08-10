// HTTP 入口：提交、审批、列表。列表接口按数据范围过滤。
// 注意：审批成功后只落库并返回，没有任何邮件/短信/推送通知。

import { Hono } from "hono";
import { requireRole } from "./auth.ts";
import { approveLevel1, approveLevel2, reject } from "./approval.ts";
import { createRequest, type LeaveRequest } from "./leave-request.ts";
import { visibleRequests } from "./scope.ts";
import type { User } from "./roles.ts";
import { BalanceStore } from "./balance.ts";

const app = new Hono().basePath("/api");
const store = new Map<string, LeaveRequest>();
const users = new Map<string, User>();
const balances = new BalanceStore();

function ownerOf(request: LeaveRequest): User {
  return users.get(request.employeeId)!;
}

// 提交申请：任何登录员工都可提交自己的请假。
app.post("/leave", (c: any) => {
  const actor = c.get("user") as User;
  requireRole(actor, "employee");
  const body = c.get("body");
  const request = createRequest(body.id, actor.id, body.type, body.days);
  store.set(request.id, request);
  return c.json(request);
});

// 一级审批：直属经理。
app.post("/leave/:id/approve-l1", (c: any) => {
  const actor = c.get("user") as User;
  const request = store.get(c.req.param("id"))!;
  const updated = approveLevel1(actor, ownerOf(request), request);
  store.set(updated.id, updated);
  return c.json(updated); // 仅落库返回，不发通知
});

// 二级审批（终审，扣减余额）：HR。
app.post("/leave/:id/approve-l2", (c: any) => {
  const actor = c.get("user") as User;
  const request = store.get(c.req.param("id"))!;
  const updated = approveLevel2(actor, request, balances);
  store.set(updated.id, updated);
  return c.json(updated); // 仅落库返回，不发通知
});

// 驳回。
app.post("/leave/:id/reject", (c: any) => {
  const request = store.get(c.req.param("id"))!;
  const updated = reject(request);
  store.set(updated.id, updated);
  return c.json(updated);
});

// 列表：按查看者的数据范围过滤。
app.get("/leave", (c: any) => {
  const actor = c.get("user") as User;
  const all = [...store.values()];
  return c.json(visibleRequests(actor, all, ownerOf));
});

export default app;
