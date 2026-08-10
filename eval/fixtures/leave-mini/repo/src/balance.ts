// 假期余额的存储与扣减。扣减只在终审通过时发生，且带库存不足的校验。

export class BalanceError extends Error {}

/** 极简内存余额表：员工 id -> 剩余天数。 */
export class BalanceStore {
  private readonly days = new Map<string, number>();

  set(employeeId: string, remaining: number): void {
    this.days.set(employeeId, remaining);
  }

  remaining(employeeId: string): number {
    return this.days.get(employeeId) ?? 0;
  }

  /** 扣减指定天数；余额不足则抛错，不做部分扣减。 */
  deduct(employeeId: string, days: number): void {
    const current = this.remaining(employeeId);
    if (days > current) {
      throw new BalanceError(`余额不足：剩余 ${current} 天，申请 ${days} 天`);
    }
    this.days.set(employeeId, current - days);
  }

  /** 归还天数（例如已扣减后又被撤销时使用）。 */
  restore(employeeId: string, days: number): void {
    this.days.set(employeeId, this.remaining(employeeId) + days);
  }
}
