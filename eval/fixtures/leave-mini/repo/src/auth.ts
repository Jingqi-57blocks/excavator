// 授权守卫：接口层面的角色校验与"经理管辖关系"校验。
// 与 scope.ts 的区别：这里决定"能不能做这个动作"，scope 决定"能看到哪些数据"。

import { hasRoleAtLeast, isDirectManagerOf, type Role, type User } from "./roles.ts";

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** 要求 actor 至少具备 required 角色，否则抛授权错误。 */
export function requireRole(actor: User, required: Role): void {
  if (!hasRoleAtLeast(actor, required)) {
    throw new AuthorizationError(`需要 ${required} 及以上角色，当前为 ${actor.role}`);
  }
}

/** 一级审批的守卫：只有申请人的直属经理才能一级审批。 */
export function assertCanApproveLevel1(actor: User, applicant: User): void {
  if (!isDirectManagerOf(actor, applicant)) {
    throw new AuthorizationError("只有申请人的直属经理才能进行一级审批");
  }
}

/** 二级审批的守卫：只有 HR 才能二级审批（终审）。 */
export function assertCanApproveLevel2(actor: User): void {
  requireRole(actor, "hr");
}
