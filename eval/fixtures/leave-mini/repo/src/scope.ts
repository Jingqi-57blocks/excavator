// 数据范围规则：决定一个用户在列表里能看到哪些请假申请。
// 这是授权维度里最容易被漏读的一条——它不是"能不能调用接口"，而是"能看到哪些行"。

import { isDirectManagerOf, type User } from "./roles.ts";
import type { LeaveRequest } from "./leave-request.ts";

/** viewer 能否查看某一条 request。 */
export function canViewLeave(viewer: User, request: LeaveRequest, owner: User): boolean {
  // 员工只能看自己的申请。
  if (viewer.role === "employee") return request.employeeId === viewer.id;
  // 经理只能看自己直接下属的申请，看不到平级或其他团队。
  if (viewer.role === "manager") return isDirectManagerOf(viewer, owner);
  // HR 可以看全部申请，不受团队边界限制。
  return viewer.role === "hr";
}

/** 按数据范围过滤出 viewer 可见的申请集合。 */
export function visibleRequests(viewer: User, requests: LeaveRequest[], ownerOf: (r: LeaveRequest) => User): LeaveRequest[] {
  return requests.filter((request) => canViewLeave(viewer, request, ownerOf(request)));
}
