// 两级审批编排：一级（直属经理）-> 二级（HR）-> 终审通过时扣减余额。
// 余额扣减刻意放在二级通过这一步，且只在 annual/sick 类型上发生。

import { assertCanApproveLevel1, assertCanApproveLevel2 } from "./auth.ts";
import type { User } from "./roles.ts";
import { canTransition, type LeaveRequest } from "./leave-request.ts";
import type { BalanceStore } from "./balance.ts";

export class ApprovalError extends Error {}

/** 一级审批：直属经理把 pending 推进到 level1Approved。 */
export function approveLevel1(actor: User, applicant: User, request: LeaveRequest): LeaveRequest {
  assertCanApproveLevel1(actor, applicant);
  if (!canTransition(request.status, "level1Approved")) {
    throw new ApprovalError(`无法从 ${request.status} 进行一级审批`);
  }
  return { ...request, status: "level1Approved" };
}

/**
 * 二级审批（终审）：HR 把 level1Approved 推进到 approved，并在此扣减余额。
 * 无薪假（unpaid）不占用余额，因此不扣减；其余类型扣减对应天数。
 */
export function approveLevel2(actor: User, request: LeaveRequest, balances: BalanceStore): LeaveRequest {
  assertCanApproveLevel2(actor);
  if (!canTransition(request.status, "approved")) {
    throw new ApprovalError(`无法从 ${request.status} 进行二级审批`);
  }
  if (request.type !== "unpaid") {
    balances.deduct(request.employeeId, request.days);
  }
  return { ...request, status: "approved" };
}

/** 驳回：任一级都可驳回，进入终态 rejected，且不扣减余额。 */
export function reject(request: LeaveRequest): LeaveRequest {
  if (!canTransition(request.status, "rejected")) {
    throw new ApprovalError(`无法从 ${request.status} 驳回`);
  }
  return { ...request, status: "rejected" };
}
