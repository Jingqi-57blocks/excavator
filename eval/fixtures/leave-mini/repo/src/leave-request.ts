// 请假申请的模型与状态机。状态流转是审批流程的骨架。

export type LeaveType = "annual" | "sick" | "unpaid";

/**
 * 状态生命周期：
 *   pending          刚提交，等待一级审批
 *   level1Approved   直属经理已一级审批，等待 HR 二级审批
 *   approved         HR 二级审批通过（终态），此时才扣减余额
 *   rejected         任一级驳回（终态），不扣减余额
 */
export type LeaveStatus = "pending" | "level1Approved" | "approved" | "rejected";

export interface LeaveRequest {
  id: string;
  employeeId: string;
  type: LeaveType;
  days: number;
  status: LeaveStatus;
}

/** 允许的状态转移；任何不在表中的转移都是非法的。 */
const TRANSITIONS: Record<LeaveStatus, LeaveStatus[]> = {
  pending: ["level1Approved", "rejected"],
  level1Approved: ["approved", "rejected"],
  approved: [],
  rejected: []
};

export function canTransition(from: LeaveStatus, to: LeaveStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function createRequest(id: string, employeeId: string, type: LeaveType, days: number): LeaveRequest {
  return { id, employeeId, type, days, status: "pending" };
}
