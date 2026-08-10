// 角色定义与层级。系统只认识三种角色，权限完全由角色驱动。

export type Role = "employee" | "manager" | "hr";

export interface User {
  id: string;
  role: Role;
  /** 直属经理的用户 id；HR 与顶层经理没有上级。 */
  managerId: string | null;
}

/** 角色的权限等级：数值越大权限越广。HR 最高，员工最低。 */
const RANK: Record<Role, number> = {
  employee: 1,
  manager: 2,
  hr: 3
};

/** actor 是否至少具备 required 角色的权限等级。 */
export function hasRoleAtLeast(actor: User, required: Role): boolean {
  return RANK[actor.role] >= RANK[required];
}

/** actor 是否是 subject 的直属经理（一级审批人由此确定）。 */
export function isDirectManagerOf(actor: User, subject: User): boolean {
  return actor.role === "manager" && subject.managerId === actor.id;
}
